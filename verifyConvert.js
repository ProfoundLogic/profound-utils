'use strict'

const { readIbmISrcMbr, getIbmIMemberList } = require('./shared/asyncUtils')
const { tmpdir, type } = require('os')
const { promises: fsPromises } = require('fs')
const { join, parse, format } = require('path')
const execFile = require('util').promisify(require('child_process').execFile)
const pino = require('pino')

const logger = pino({
  prettyPrint: {
    colorize: true,
    ignore: 'time,pid,hostname'
  },
  level: process.env.LOG_LEVEL || 'info'
})

// Skip any noise from down-stream
process.env.LOG_LEVEL = 'error'
const { convert: ddsToJson } = require('./ddsToJson')
const { convert: jsonToDds } = require('./jsonToDds')

let inputCount = 0
let successCount = 0
const failDetails = []

/**
 * @description This tool verifies the DDS conversion process, by running two conversions to convert a DDS file
 *              into JSON, then back to DDS. It then compares the twice converted file to the original DDS file
 *              using a 'diff' comparison. The success/fail messages are printed to the console.
 * @param {String} srcFile The Input Source File name. This can be an IFS name, or
 *                         a Source Physical File name used in conjunction with the srcLib and srcMbr parameters.
 * @param {String} [srcLib] The Input Library containing the Source File.
 * @param {String} [srcMbr] The Input Source Member name.
 * @returns {Promise<String>} The error message if we reject.
 * @since 1.0.0
 */
const main = async (srcFile, srcLib, srcMbr) => {
  try {
    logger.debug('main() started with :', { srcFile: srcFile, srcLib: srcLib, srcMbr: srcMbr })

    const tempOutDir = await fsPromises.mkdtemp(join(tmpdir(), 'profound-utils-'))
      .then(result => result)
      .catch(err => Promise.reject(err))

    // Check if the Output file is IFS or Lib/File/Mbr
    let isDdsFile = false
    if (type() === 'OS400' && srcLib && srcMbr && typeof srcFile === 'string' && parse(srcFile).dir === '') {
      srcFile = srcFile.toUpperCase()
      if (typeof srcLib === 'string') srcLib = srcLib.toUpperCase()
      if (typeof srcMbr === 'string') srcMbr = srcMbr.toUpperCase()
      isDdsFile = true
    }

    logger.debug('main() determined file type', { isDdsFile: isDdsFile })

    let origDdsFile

    if (isDdsFile) {
      origDdsFile = await readIbmISrcMbr(srcFile, srcLib, srcMbr, 'file')
    } else {
      // If IFS file, may need to remove the leading dates & line #'s
      const originalDds = await fsPromises.readFile(srcFile, 'utf8')
      const CRLF = '\r\n'
      const originalDdsLines = originalDds.split(CRLF)
      if (isNaN(Number.parseInt(originalDdsLines[0].substr(0, 12)))) {
        logger.debug('Original DDS file does NOT have leading Dates/Sequences')
        origDdsFile = srcFile
      } else {
        logger.debug('Original DDS file has leading Dates/Sequences')
        const fileParts = parse(srcFile)
        fileParts.dir = tempOutDir
        fileParts.base = fileParts.name + fileParts.ext + 'X'
        const tempOutFile = format(fileParts)
        const tmpDdsLines = originalDdsLines.map(srcLine => isNaN(Number.parseInt(srcLine.substr(0, 12))) ? srcLine : srcLine.substr(12))
        await fsPromises.writeFile(tempOutFile, tmpDdsLines.join(CRLF))
        origDdsFile = tempOutFile
      }
    }

    // JSON -> DDS V1 and V2 need the original DDS file for constructing the
    // target DDS
    process.env.JSON_TO_DDS_ORIGINAL_DDS_FILE = origDdsFile
    logger.debug('main() setting process.env.JSON_TO_DDS_ORIGINAL_DDS_FILE :', origDdsFile)

    return ddsToJson(tempOutDir, origDdsFile, null, undefined)
      .then(async rtnJson => {
        const outFile = rtnJson.replace('.json', '.dspf')
        return jsonToDds(rtnJson, outFile, null, null)
      })
      .then(async cvtDdsFile => execFile('diff', [origDdsFile, cvtDdsFile]))
      .then(result => {
        successCount += 1
        return 'SUCCESS'
      })
      .catch(err => {
        failDetails.push({ file: srcFile, err: err, cmd: err.cmd, diff: err.stdout })
        const failed = 'FAILED'
        return Promise.reject(failed)
      })
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Processes generic file names for non-IBM i systems. It will create
 *              a list of directory entries, then filter according to the search criteria,
 *              then process each entry.
 * @param {String} genericName The Input Source File name. This should be a path-based file name.
 * @returns {Promise<Void|Error>} The error message if we reject.
 * @since 1.0.0
 */
const processGenericName = async (genericName) => {
  logger.debug('processGenericName() started with :', { genericName: genericName })

  const parts = parse(genericName)

  fsPromises.readdir(parts.dir)
    .then(async fileList => {
      logger.debug('processGenericName() directory file list', fileList)
      fileList = fileList.filter(file => {
        return file.startsWith(parts.name.split('*')[0])
      })
      inputCount = fileList.length
      logger.debug('processGenericName() filtered file list', fileList)
      for (const file of fileList) {
        const fileParts = parse(file)
        if (parts.ext === '' || parts.ext === fileParts.ext) {
          logger.debug('processGenericName() processing file :', fileParts)
          fileParts.dir = parts.dir
          let fil = format(fileParts)
          await main(fil)
            .then(result => logger.info(`DDS file ${fil} verification ${result}.`))
            .catch(err => logger.error(`DDS file ${fil} verification ${err}.`))
        } else {
          logger.debug('processGenericName() skipping file :', fileParts)
        }
      }
    })
    .catch(err => Promise.reject(err))
    .finally(() => summary())
}

const summary = async () => {
  console.log('\n')
  logger.info('Conversion Summary\n')
  logger.info(`${inputCount} Input Source files.`)
  logger.info(`${successCount} verification SUCCESS.`)
  logger.error(`${failDetails.length} verification FAILED.\n`)
  if (failDetails.length > 0) {
    let count = 0
    for (const fail of failDetails) {
      count += 1
      logger.error(`Fail #${count} :`, fail.file)
      if (fail.cmd) {
        logger.error(fail.cmd)
        console.log(fail.diff)
      } else {
        logger.error(fail.err)
      }
    }
  }
}

/**
 * @description Processes generic file names for IBM i systems. It will create
 *              a list of Member entries according to the search criteria,
 *              then process each entry.
 * @param {String} fil The Input Source File name. This can be an IFS name, or
 *                         a Source Physical File name used in conjunction with the srcLib and srcMbr parameters.
 * @param {String} [lib] The Input Library containing the Source File.
 * @param {String} [genericMbr] The Input Source Member name.
 * @returns {Promise<Void|Error>} The error message if we reject.
 * @since 1.0.0
 */
const processIbmIGenericName = async (fil, lib, genericMbr) => {
  logger.debug('processIbmIGenericName() started with :', { fil: fil, lib: lib, genericName: genericMbr })

  lib = lib.toUpperCase()
  fil = fil.toUpperCase()
  genericMbr = genericMbr.toUpperCase()

  getIbmIMemberList(fil, lib, genericMbr)
    .then(async mbrList => {
      if (mbrList.length === 0) {
        logger.debug(`No Source Members were found for ${lib}/${fil}.${genericMbr}`)
      } else {
        inputCount = mbrList.length
        logger.debug('processIbmIGenericName() received member list', mbrList)
        for (const mbr of mbrList) {
          logger.debug('processIbmIGenericName() processing member :', { fil: fil, lib: lib, mbr: mbr })
          await main(fil, lib, mbr)
            .then(result => {
              logger.info(`DDS member ${lib}/${fil}.${mbr} verification ${result}.`)
            })
            .catch(err => {
              logger.error(`DDS member ${lib}/${fil}.${mbr} verification ${err}.`)
            })
        }
      }
    })
    .catch(err => Promise.reject(err))
    .finally(() => summary())
}

logger.debug('verifyConvert.js started with args :', process.argv)

if (require.main.filename !== module.filename) {
} else if (process.argv.includes('--help') || process.argv.includes('?')) {
  logger.info(`verifyConvert - This tool verifies the DDS conversion process, by running two conversions to convert a DDS file`)
  logger.info(`                into JSON, then back to DDS. It then compares the DDS output back to the original DDS file`)
  logger.info(`                using a 'diff' comparison. If any differences are found, the output is printed to the console.\n`)
  logger.info(`Usage : verifyConvert input-DDS-file [input-library] [input-member]`)
} else if (process.argv.length > 5) {
  logger.error(`Too many parameters were specified.\n`)
  logger.info(`Usage : verifyConvert input-DDS-file [input-library] [input-member]`)
} else if (process.argv.length !== 3 && process.argv.length < 5) {
  logger.error(`Too few parameters were specified.\n`)
  logger.info(`Usage : verifyConvert input-DDS-file [input-library] [input-member]`)
} else {
  const srcFile = process.argv[2]
  const srcLib = process.argv[3]
  const srcMbr = process.argv[4]

  logger.debug('verifyConvert.js passed-validation')

  // Is the Input file Generic name ?
  if (typeof srcLib === 'string' && typeof srcMbr === 'string' && srcMbr.includes('*')) {
    logger.debug('verifyConvert.js processing IBM i generic lib/file/member name')
    processIbmIGenericName(srcFile, srcLib, srcMbr)
  } else if (srcFile.includes('*')) {
    logger.debug('verifyConvert.js processing non-IBM i generic file name')
    processGenericName(srcFile)
  } else {
    logger.debug('verifyConvert.js processing non-generic file/member name')
    main(srcFile, srcLib, srcMbr)
      .then(result =>
        logger.info(`DDS file ${srcFile} verification ${result}.`)
      )
      .catch(err => {
        logger.error(`DDS file ${srcFile} verification ${err}.`)
      })
      .finally(() => summary())
  }
}

exports.verify = main
