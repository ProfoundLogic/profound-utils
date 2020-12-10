'use strict'

const { promises: fsPromises, constants } = require('fs')
const { format, parse, resolve } = require('path')
const { isValidLibrary, isValidDdsSourceFile, isValidDdsMember, readIbmISrcMbr, getIbmIMemberText } = require('./shared/asyncUtils')
const pino = require('pino')

const logger = pino({
  prettyPrint: {
    colorize: true,
    ignore: 'time,pid,hostname'
  },
  level: process.env.LOG_LEVEL || 'info'
})

const CRLF = '\r\n'

let isDdsFile = false
let outFileName

/**
 * @description Extracts the Formats object from the HTML tags in the DSPF source.
 * @param {String[]} srcLines The input DDS Source Member converted to String array.
 * @returns {Promise<Object[]>} The Formats array.
 * @since 1.0.0
 */
const getFormatsFromSrc = async (srcLines) => {
  try {
    logger.debug('getFormatsFromSrc() started with : ', typeof srcLines, 'srcLines =', srcLines)
    let isHtmlJsonTag = false
    let htmlTag = ''
    const formats = []

    /**
     * @param {string} str
     */
    const addToFormats = (str) => {
      // Sanitize any IBM i delimiter content such as double quote
      formats.push(JSON.parse(str.replace(/''/g, `'`)))
    }

    srcLines.forEach(line => {
      // Are we still reading an HTML tag ?
      if (isHtmlJsonTag) {
        // Skip HTML tag if line starts with a new HTML tag
        const strPos = line.substr(44, 6) === `HTML('` ? 50 : 44
        // OK, so is the HTML tag continuing, or is this line potentially complete ?
        if (line.substr(79, 1) !== '-') {
          // We might have reached max DDS HTML length, so see if we can parse
          const endPos = line.lastIndexOf(`')`)
          try {
            addToFormats(htmlTag + line.substring(strPos, endPos))
            htmlTag = ''
            isHtmlJsonTag = false
          } catch (error) {
            // Nope, so there must be more data
            htmlTag += line.substring(strPos, endPos)
            return
          }
        } else {
          htmlTag += line.substring(strPos, 79)
          return
        }
      }

      isHtmlJsonTag = (line.substr(44, 7) === `HTML('{`)
      if (isHtmlJsonTag) {
        // OK, so html tag continuing, or one and done ?
        if (line.substr(79, 1) !== '-') {
          const endPos = line.lastIndexOf(`')`)
          addToFormats(htmlTag + line.substring(50, endPos))
          isHtmlJsonTag = false
        } else {
          htmlTag += line.substring(50, 79)
        }
      }
    })

    return formats
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Extracts the Keywords object from the File-level keywords in the DSPF source.
 * @param {String[]} srcLines The input DDS Source Member converted to String array.
 * @returns {Promise<String[]>} The Keywords array.
 * @since 1.0.0
 */
const getKeywordsFromSrc = async (srcLines) => {
  try {
    logger.debug('getKeywordsFromSrc() started with : ', typeof srcLines, 'srcLines =', srcLines)
    const keywords = []

    for (const line of srcLines) {
      // Iterate through the active Keywords until we get to the first Record Format
      if (line.substr(5, 2) === 'A ' && line.substr(16, 1) === 'R') {
        break
      } else {
        if (line.substr(5, 2) === 'A ' || line.substr(5, 5) === 'A*PUI') {
          if (line.substr(44, 36).trimRight()) {
            keywords.push(line.substr(44, 36).trimRight())
          }
        }
      }
    }
    return keywords
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Wrapper function to validate all the input parameters.
 * @param {String} outDir The Output directory to create the JSON file in.
 * @param {String} fil The Input Source File name.
 * @param {String} [lib] The Library containing the Source File.
 * @param {String} [mbr] The Member name.
 * @returns {Promise<String>} The error message if we reject.
 * @since 1.0.0
 */
const validateParameters = async (outDir, fil, lib, mbr) => {
  try {
    logger.debug('validateParameters() started with : ', typeof outDir, 'outDir =', outDir, typeof fil, 'fil =', fil, typeof lib, 'lib =', lib, typeof mbr, 'mbr =', mbr)
    let err

    // Verify output directory
    if (typeof outDir === 'undefined') {
      err = `Output Directory was not specified.\n`
    } else {
      err = await fsPromises.stat(outDir)
        .then(async stats => {
          if (!stats.isDirectory()) {
            return `Output Directory '${outDir}' exists but is not a directory.\n`
          }
        })
        .catch(() => `Output Directory '${outDir}' does not exist.\n`)
    }

    if (err) {
      return Promise.reject(err)
    }

    // Verify Input source file
    if (typeof fil === 'undefined') {
      err = `Input Source File was not specified.\n`
    } else {
      if (!isDdsFile) {
        if (lib) {
          err = `Input File '${fil}' is a path-based name, so Input Library '${lib}' must not be specified.\n`
        } else if (mbr) {
          err = `Input File '${fil}' is a path-based name, so Input Member '${mbr}' must not be specified.\n`
        } else {
          err = await fsPromises.stat(fil)
            .then(stats => stats.isFile() ? null : `Input File '${fil}' exists but is not a file.\n`)
            .catch(() => `Input File '${fil}' does not exist.\n`)
          if (!err) {
            err = await fsPromises.access(fil, constants.R_OK)
              .catch(() => `Input Source File '${fil}' exists, but you must have read permissions.\n`)
          }
        }
      } else if (typeof fil !== 'string') {
        err = `Input Source File '${fil}' is not a string value.\n`
      } else {
        if (typeof lib === 'undefined') {
          err = `Input Source File '${fil}' is NOT a path-based name, so Input Library '${lib}' is mandatory.\n`
        } else if (typeof mbr === 'undefined') {
          err = `Input Source File '${fil}' is NOT a path-based name, so Input Member '${mbr}' is mandatory.\n`
        } else {
          err = await isValidLibrary(lib)
            .then(() => isValidDdsSourceFile(fil, lib))
            .then(() => isValidDdsMember(fil, lib, mbr))
            .catch(error => error)
        }
      }
    }
    if (err) {
      return Promise.reject(err)
    }

    // Check that output file is writeable
    const pathObj = { dir: resolve(outDir) }
    if (isDdsFile) {
      // 6457: per Rob, json file name should be memberName.json to make it easier for PJSCONVERT
      // pathObj.base = `${lib}.${fil}.${mbr}.json`
      pathObj.base = `${mbr}.json`
    } else {
      pathObj.base = parse(fil).name + '.json'
    }
    outFileName = format(pathObj)

    err = await fsPromises.open(outFileName, 'w')
      .then(async handle => {
        await handle.close()
      })
      .catch(() => `Insufficient write permissions on Output File '${outFileName}'.\n`)
    if (err) {
      return Promise.reject(err)
    }
  } catch (error) {
    return Promise.reject(error.message)
  }
}

/**
 * @description Extract the original DDS source lines for All-In-One section in JSON.
 * @param {String[]} srcLines The input DDS Source Member converted to String array.
 * @returns {Promise<String[]>} The original DDS array to be stored in HTML for All-In-One, or Error Message if we reject.
 * @since 1.0.0
 */
const getDdsFromSrc = async (srcLines) => {
  logger.debug('getDdsFromSrc() started with : ', typeof srcLines, 'srcLines =', srcLines)
  const getBoundFields = async (rcdFmt) => {
    logger.debug('getBoundFields() started with : ', typeof rcdFmt, 'rcdFmt =', rcdFmt)
    let fields = []

    // Extract all bound fields from each record format
    for (const item of rcdFmt.items) {
      for (const itemProperty in item) {
        if (item.hasOwnProperty(itemProperty)) {
          const itemValue = item[itemProperty]
          if (typeof itemValue === 'object' && itemValue.fieldName) {
            fields.push(itemValue.fieldName.toUpperCase())
          }
        }
      }
    }
    return fields
  }

  const htmlOpen = `HTML('`
  const rcdFmtOpen = `A          R`
  const returnDds = []

  let rcdFmt
  let rcdFmtObj
  let boundFields
  let isSFL = false

  const formats = await getFormatsFromSrc(srcLines)

  for (let srcIdx = 0; srcIdx < srcLines.length; srcIdx++) {
    const line = srcLines[srcIdx]

    // Grab the Record Format details
    if (line.substr(5, 12) === rcdFmtOpen) {
      isSFL = (line.substr(44, 36).trim() === 'SFL')
      rcdFmt = line.substr(18, 10).trimRight()
      rcdFmtObj = formats.filter(x => x.screen['record format name'].toUpperCase() === rcdFmt)
      boundFields = null
    }

    // Skip any Control Formats
    if (line.substr(5, 2) === 'A ' && line.substr(44, 10) === htmlOpen + 'QPUI') {
      while (srcLines[srcIdx].substr(79, 1) === '-') {
        srcIdx++
      }
      continue
    }

    // Skip any Screen Formats
    if (!isSFL && line.substr(5, 2) === 'A ' && line.substr(44, 7) === htmlOpen + '{') {
      for (; srcIdx < srcLines.length; srcIdx++) {
        if (srcLines[srcIdx].substr(5, 2) === 'A ' &&
          srcLines[srcIdx].substr(79, 1) !== '-' &&
          srcLines[srcIdx + 1].substr(44, 6) !== htmlOpen) {
          let tempText = srcLines[srcIdx - 1].substring(44, 79) + srcLines[srcIdx].substring(44, 80)
          let endPos = tempText.lastIndexOf(`}')`)
          if (endPos !== -1) {
            boundFields = await getBoundFields(rcdFmtObj[0])
            break
          }
        }
      }
    } else {
      if (line !== '' && line.substr(5, 4) !== 'A*%%') {
        if (boundFields && line.substr(5, 2) === 'A ' && line.substr(37, 1) === 'H') {
          let fieldName = line.substr(18, 10).trimRight()
          let x = boundFields.indexOf(fieldName)
          if (x !== -1) {
            continue
          }
        }
        // eslint-disable-next-line no-control-regex
        returnDds.push(line.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, ' ').trimRight())
      }
    }
  }
  return returnDds
}

/**
 * @description Main function to convert the DDS source member to JSON.
 * @param {String} outDir The Output directory to create the JSON file in.
 * @param {String} srcFile The Source File name. This can be a path-based name, or
 *                         a Source Physical File name used in conjunction with the srcLib and srcMbr parameters.
 * @param {String} [srcLib] (Optional) The Library containing the Source File.
 * @param {String} [srcMbr] (Optional) The Source Member name.
 * @returns {Promise<String>} The output JSON file name, or the error message if we reject.
 * @since 1.0.0
 */
const main = async (outDir, srcFile, srcLib, srcMbr) => {
  try {
    logger.debug('main() started with : ', typeof outDir, 'outDir =', outDir, typeof srcFile, 'srcFile =', srcFile, typeof srcLib, 'srcLib =', srcLib, typeof srcMbr, 'srcMbr =', srcMbr)
    logger.info('Verifying parameters...\n')
    let isValidParameters
    let parts

    // Check if the Input file is path-based or Lib/File/Mbr
    if (typeof srcFile === 'string') {
      parts = parse(srcFile)
    }
    if (parts && parts.dir === '') {
      srcFile = srcFile.toUpperCase()
      if (typeof srcLib === 'string') srcLib = srcLib.toUpperCase()
      if (typeof srcMbr === 'string') srcMbr = srcMbr.toUpperCase()
      isDdsFile = true
    }

    isValidParameters = await validateParameters(outDir, srcFile, srcLib, srcMbr)
      .then(() => true)
      .catch(err => {
        logger.error('Parameter Validation failed : ', err)
      })

    if (!isValidParameters) {
      return Promise.reject(Error(`One or more parameters failed validation, please check above messages and try again.`))
    }

    logger.info('Converting DDS to JSON...\n')

    let srcLines
    if (isDdsFile) {
      srcLines = await readIbmISrcMbr(srcFile, srcLib, srcMbr)
        .then(source => source.split(CRLF))
    } else {
      srcLines = await fsPromises.readFile(srcFile, 'utf8')
        .then(source => source.split(CRLF).map(srcLine => isNaN(Number.parseInt(srcLine.substr(0, 12))) ? srcLine : srcLine.substr(12)))
    }

    // Check that this is a Rich Display file
    if (srcLines.findIndex(srcLine => srcLine.substr(44, 5) === 'HTML(') === -1) {
      const errText = 'The Input source file is not a Rich Display File'
      return Promise.reject(errText)
    }

    const dspf = {
      text: isDdsFile ? await getIbmIMemberText(srcFile, srcLib, srcMbr) || '' : 'TODO - look for .ibmi properties',
      formats: await getFormatsFromSrc(srcLines),
      keywords: await getKeywordsFromSrc(srcLines)
    }

    if (dspf.keywords.includes('ALLINONE')) {
      dspf.dds = await getDdsFromSrc(srcLines)
    }

    logger.info(`Writing output file : ${outFileName}\n`)

    await fsPromises.writeFile(outFileName, JSON.stringify(dspf, null, 2))

    return outFileName
  } catch (error) {
    return Promise.reject(error)
  }
}

if (require.main.filename !== module.filename) {
} else if (process.argv.includes('--help') || process.argv.includes('?')) {
  logger.info(`ddsToJson - This tool will convert an existing DDS source-based DSPF into JSON`)
  logger.info(`            format. This will allow you to realize many advantages over the`)
  logger.info(`            DDS version, such as performing mass Find/Replace changes in`)
  logger.info(`            your favorite Source editor, moving the screen to a Git repository, etc.\n`)
  logger.info(`Usage : ddsToJson output-directory input-DDS-file [input-library] [input-member]`)
} else if (process.argv.length > 6) {
  logger.error(`Too many parameters were specified.\n`)
  logger.info(`Usage : ddsToJson output-directory input-DDS-file [input-library] [input-member]`)
} else if (process.argv.length !== 4 && process.argv.length < 6) {
  logger.error(`Too few parameters were specified.\n`)
  logger.info(`Usage : ddsToJson output-directory input-DDS-file [input-library] [input-member]`)
} else {
  const outDirectory = process.argv[2]
  const inFil = process.argv[3]
  const inLib = process.argv[4]
  const inMbr = process.argv[5]

  main(outDirectory, inFil, inLib, inMbr)
    .then(result => {
      if (isDdsFile) {
        logger.info(`DDS file ${inLib.toUpperCase()}/${inFil.toUpperCase()}.${inMbr.toUpperCase()} was converted successfully.\n`)
      } else {
        logger.info(`DDS file ${inFil} was converted successfully.\n`)
      }
    }
    )
    .catch(err => {
      logger.error(`${err}\n`)
    })
}

exports.convert = main
