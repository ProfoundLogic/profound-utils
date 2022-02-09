'use strict'

const { promises: fsPromises, constants } = require('fs')
const { join, parse, sep } = require('path')
const { tmpdir } = require('os')
const { execSql, getIbmIMemberText, isValidLibrary, isValidDdsSourceFile, chunkData, readIbmISrcMbr } = require('./shared/asyncUtils')
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

/**
 * @description Writes to an IBM i source-physical file member.
 * @param {String} srcFile The Source-stream file in IFS.
 * @param {String} fil The Source physical-file to write to.
 * @param {String} lib The Library containing the Source-physical file.
 * @param {String} mbr The Source Member.
 * @param {String} mbrText The Source Member text.
 * @returns {Promise<String>} The stream of the source member.
 * @since 1.0.0
 */
const writeIbmISrcMbr = async (srcFile, fil, lib, mbr, mbrText) => {
  try {
    logger.debug('writeIbmISrcMbr() started with : ', typeof srcFile, 'srcFile =', srcFile, typeof fil, 'fil =', fil, typeof lib, 'lib =', lib, typeof mbr, 'mbr =', mbr, typeof mbrText, 'mbrText =', mbrText)
    const outFile = `/QSYS.LIB/${lib}.LIB/${fil}.FILE/${mbr}.MBR`
    logger.info('Writing output file : ', outFile)

    let stmt = `CPYFRMSTMF FROMSTMF('${srcFile}') TOMBR('${outFile}') MBROPT(*ADD) STMFCCSID(1208)`
    await execSql('CALL QCMDEXC(?)', stmt)

    // Change Member Type
    stmt = `CHGPFM FILE(${lib}/${fil}) MBR(${mbr}) SRCTYPE(DSPF) TEXT('${mbrText}')`
    await execSql('CALL QCMDEXC(?)', stmt)

    // Re-sequence file
    stmt = `RGZPFM FILE(${lib}/${fil}) MBR(${mbr}) SRCOPT(*DATE *SEQNBR) SRCSEQ(0.01 0.01)`
    await execSql('CALL QCMDEXC(?)', stmt)
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Tests to see if the Source member exists in the Library and File that is passed.
 * @param {String} fil The Source File name.
 * @param {String} lib The Library containing the Source File.
 * @param {String} mbr The Source member name to verify.
 * @returns {Promise<String>} The error message if the DDS Member already exists.
 * @since 1.0.0
 */
const isDdsMemberExist = async (fil, lib, mbr) => {
  logger.debug('isDdsMemberExist() started with : ', typeof fil, 'fil =', fil, typeof lib, 'lib =', lib, typeof mbr, 'mbr =', mbr)
  const err = await getIbmIMemberText(fil, lib, mbr)
    .then(() => `Source Member '${mbr}' exists in file ${lib}/${fil}, and cannot be over-written.`)
    .catch(() => null)

  if (err) {
    return Promise.reject(err)
  }
}

/**
 * @description Wrapper function to validate all the input parameters.
 * @param {String} inJsonFile The Input source file in JSON format.
 * @param {String} fil The Output File name.
 * @param {String} [lib] The Library containing the Output Source File.
 * @param {String} [mbr] The Output Member name.
 * @returns {Promise<String>} The error message if we reject, or the valid JSON data if valid.
 * @since 1.0.0
 */
const validateParameters = async (inJsonFile, fil, lib, mbr) => {
  logger.debug('validateParameters() started with : ', typeof inJsonFile, 'inJsonFile =', inJsonFile, typeof fil, 'fil =', fil, typeof lib, 'lib =', lib, typeof mbr, 'mbr =', mbr)
  let err
  let validJsonFile

  // Check the Input JSON file
  if (typeof inJsonFile === 'undefined') {
    err = `Input JSON File was not specified.\n`
  } else {
    err = await fsPromises.readFile(inJsonFile, 'utf8')
      .then(fileData => {
        try {
          validJsonFile = JSON.parse(fileData)
        } catch (error) {
          return `Input JSON file '${inJsonFile}' is not a valid JSON file.\n`
        }
      })
      .catch(() => {
        return `Input JSON file '${inJsonFile}' must exist and you must have read permissions.\n`
      })
  }
  if (err) {
    return Promise.reject(err)
  }

  // Verify output file
  if (typeof fil === 'undefined') {
    err = `Output File Name was not specified.\n`
  } else {
    // Check if the Output file is path-based or a Lib/File/Mbr
    if (!isDdsFile) {
      if (lib) {
        err = `Output File Name '${fil}' is a path-based name, so Output Library '${lib}' must not be specified.\n`
      } else if (mbr) {
        err = `Output File Name '${fil}' is a path-based name, so Output Member '${mbr}' must not be specified.\n`
      } else {
        const parts = parse(fil)
        // Check the Output path
        err = await Promise.all([
          fsPromises.stat(parts.dir),
          fsPromises.access(parts.dir, constants.W_OK)])
          .then(result => result[0].isDirectory() ? null : Promise.reject(Error))
          .catch(() => `Output Directory '${parts.dir}' must exist and you must have write permissions.\n`)
        // Check the Output file
        if (!err) {
          err = await fsPromises.access(fil, constants.F_OK)
            .catch(() => true)
            .then(isNotExists => isNotExists ? null : fsPromises.access(fil, constants.W_OK))
            .catch(() => `Output File '${fil}' already exists, but you don't have write permissions.\n`)
        }
      }
    } else if (typeof fil !== 'string') {
      err = `Output File Name is a mandatory value.\n`
    } else {
      if (typeof lib === 'undefined') {
        err = `Output File '${fil}' is NOT a path-based name, so Output Library '${lib}' is mandatory.\n`
      } else if (typeof mbr === 'undefined') {
        err = `Output File '${fil}' is NOT a path-based name, so Output Member '${mbr}' is mandatory.\n`
      } else {
        err = await isValidLibrary(lib)
          .then(() => isValidDdsSourceFile(fil, lib))
          .then(() => isDdsMemberExist(fil, lib, mbr))
          .catch(error => error)
      }
    }
  }
  if (err) {
    return Promise.reject(err)
  } else {
    return validJsonFile
  }
}

/**
 * @description htmlObjToDdsLines - Takes an HTML object in JSON format, and formats it into DDS format. It chunks
 *                                  the data into 2500 byte sections to avoid compile issues with large HTML sections.
 * @param {Object} htmlObj The Input object in JSON format.
 * @param {String} htmlLineNum The HTML line number to use on the DDS output.
 * @returns {Promise<String[]>} The Output DDS lines array.
 * @since 1.0.0
 */
const htmlObjToDdsLines = async (htmlObj, htmlLineNum) => {
  logger.debug('htmlObjToDdsLines() started with : ', typeof htmlObj, 'htmlObj =', htmlObj, typeof htmlLineNum, 'htmlLineNum =', htmlLineNum)
  const rtnLines = []
  const kwdOpen = '     A                                      '
  const htmlOpen = `     A                                ${htmlLineNum}  2HTML('`

  let htmlData = JSON.stringify(htmlObj).replace(/'/g, `''`)

  let htmlChunks = await chunkData(htmlData, 2500)

  for (const chunk of htmlChunks) {
    let pos = 0
    let len = 79 - htmlOpen.length
    let isHtmlClosed = false

    let availLength = chunk.substr(pos, len)
    if (availLength.length <= len - 2) {
      rtnLines.push(htmlOpen + chunk.substr(pos, len) + `')`)
      break
    }
    rtnLines.push(htmlOpen + chunk.substr(pos, len) + `-`)

    for (pos = len, len = 79 - kwdOpen.length; pos < chunk.length; pos += len) {
      let ddsLine = kwdOpen + chunk.substr(pos, len)
      if (ddsLine.length === 79) {
        ddsLine += '-'
      } else {
        ddsLine += `')`
        isHtmlClosed = true
      }
      rtnLines.push(ddsLine)
    }
    if (!isHtmlClosed) {
      rtnLines.push(kwdOpen + `')`)
    }
  }
  return rtnLines
}

/**
 * @description ConversionV1 - This is first version of converting the JSON source file back into a DDS Source member.
 *                             This version will take ALL the existing DDS source lines from the OLD DDS Source
 *                             File/Member, but will insert the changed JSON sections from the NEW source file, and
 *                             insert them into the HTML tags. This eliminates any risks from parsing the NEW file,
 *                             but means that you will cannot do the following: -
 *
 *                               1) Add or Remove any Record Formats in the new source file.
 *                               2) Add or remove any Bound fields in the new source file.
 *
 *                             This is currently the default method, and will be used to convert if
 *                             environment variable JSON_TO_DDS_CONVERSION_METHOD does not exist.
 *
 *                             Set environment variable JSON_TO_DDS_CONVERSION_METHOD = '1' to convert with this method.
 *
 * @param {Object} newJsonSrcObj The Input new source object in JSON format.
 * @param {String[]} origSrcLines The Input DDS Source File of the Original source.
 * @returns {Promise<String[]>} The Output DDS lines array.
 * @since 1.0.0
 */
const conversionV1 = async (newJsonSrcObj, origSrcLines) => {
  logger.debug('conversionV1() started with : ', typeof newJsonSrcObj, 'newJsonSrcObj =', newJsonSrcObj, typeof origSrcLines, 'origSrcLines =', origSrcLines)
  let ddsLines = []
  let rcdFmt
  const htmlOpen = `HTML('`
  const rcdFmtOpen = 'A          R'

  for (let srcIdx = 0; srcIdx < origSrcLines.length; srcIdx++) {
    const origSrcLine = origSrcLines[srcIdx]

    if (origSrcLine.substr(5, 12) === rcdFmtOpen) {
      rcdFmt = origSrcLine.substr(18, 10).trimRight().toUpperCase()
      ddsLines.push(origSrcLine)
      continue
    }

    // Is this is an object section, just replace it with new input
    if (origSrcLine.substr(5, 2) === 'A ' && origSrcLine.substr(44, 7) === htmlOpen + '{') {
      for (; srcIdx < origSrcLines.length; srcIdx++) {
        // Skip through the continuation lines until...
        if (origSrcLines[srcIdx].substr(5, 2) === 'A ' && origSrcLines[srcIdx].substr(79, 1) !== '-') {
          // We reach end of source...
          if (srcIdx === origSrcLines.length - 1) {
            let formatObj = newJsonSrcObj.formats.filter(x => x.screen['record format name'].toUpperCase() === rcdFmt)
            const htmlLineNum = origSrcLine.substr(38, 3)
            ddsLines.push(...await htmlObjToDdsLines(formatObj[0], htmlLineNum))
            break
          }
          // Or end of Record Format, so check to make sure there isn't another HTML continuation
          if (origSrcLines[srcIdx + 1].substr(44, 6) !== htmlOpen) {
            let tempText = origSrcLines[srcIdx - 1].substring(44, 79) + origSrcLines[srcIdx].substring(44, 80)
            let endPos = tempText.lastIndexOf(`}')`)
            if (endPos !== -1) {
              let formatObj = newJsonSrcObj.formats.filter(x => x.screen['record format name'].toUpperCase() === rcdFmt)
              const htmlLineNum = origSrcLine.substr(38, 3)
              ddsLines.push(...await htmlObjToDdsLines(formatObj[0], htmlLineNum))
              break
            }
          }
        }
      }
    } else {
      // Otherwise, just write the output from the original file
      ddsLines.push(origSrcLine)
    }
  }

  return ddsLines
}

/**
 * @description Main function to convert the JSON source file into a DDS Source member.
 * @param {String} inJson The Input source file in JSON format.
 * @param {String} srcFile The Output Source File name. This can be a path-based name, or
 *                         a Source Physical File name used in conjunction with the srcLib and srcMbr parameters.
 * @param {String} [srcLib] The Output Library containing the Source File.
 * @param {String} [srcMbr] The Output Source Member name.
 * @returns {Promise<String>} The error message if we reject.
 * @since 1.0.0
 */
const main = async (inJson, srcFile, srcLib, srcMbr, srcFilOrig, srcLibOrig, srcMbrOrig) => {
  logger.debug('main() started with : ', typeof inJson, 'inJson =', inJson, typeof srcFile, 'srcFile =', srcFile, typeof srcLib, 'srcLib =', srcLib, typeof srcMbr, 'srcMbr =', srcMbr)
  const CONVERT_METHOD = 'JSON_TO_DDS_CONVERSION_METHOD'
  try {
    logger.info('Verifying input parameters...\n')
    let isValidParameters
    let parts

    // Check if the Output file is path-based or Lib/File/Mbr
    if (typeof srcFile === 'string') {
      parts = parse(srcFile)
    }
    if (parts && parts.dir === '') {
      srcFile = srcFile.toUpperCase()
      if (typeof srcLib === 'string') srcLib = srcLib.toUpperCase()
      if (typeof srcMbr === 'string') srcMbr = srcMbr.toUpperCase()
      isDdsFile = true
    }

    let validJsonData

    isValidParameters = await validateParameters(inJson, srcFile, srcLib, srcMbr)
      .then(rtnData => {
        validJsonData = rtnData
        return true
      })
      .catch(err => {
        logger.error('Parameter Validation failed : ', err)
        return false
      })

    if (!isValidParameters) {
      return Promise.reject(Error(`One or more parameters failed validation, please check above messages and try again.`))
    } else {
      logger.info('Converting JSON to DDS...\n')

      const newJsonSrcObj = validJsonData

      // Retrieve the original DDS source for this conversion. Required for V1 conversion method.
      let originalDds
      let newDdsLines

      if (isDdsFile) {
        const parts = parse(inJson).name.split('.')
        // originalDds = await readIbmISrcMbr(parts[1], parts[0], parts[2])
        originalDds = await readIbmISrcMbr(srcFilOrig, srcLibOrig, srcMbrOrig);
      } else {
        const originalDdsFile = process.env.JSON_TO_DDS_ORIGINAL_DDS_FILE
        if (typeof originalDdsFile === 'string') {
          originalDds = await fsPromises.readFile(originalDdsFile, 'utf8')
            .catch(() => Promise.reject(Error(`Environment variable 'JSON_TO_DDS_ORIGINAL_DDS_FILE' is set but is not a valid file name.`)))
        } else {
          throw Error(`Environment variable 'JSON_TO_DDS_ORIGINAL_DDS_FILE' must be set to the location of the Original DDS file.`)
        }
      }

      // Filter out any blank lines, and any source dates & line #'s
      var originalDdsLines = originalDds.split(CRLF)
        .map(srcLine => isNaN(Number.parseInt(srcLine.substr(0, 12))) ? srcLine : srcLine.substr(12))

      switch (process.env[CONVERT_METHOD]) {
        case undefined:
          logger.info(`${CONVERT_METHOD} is not set, converting with V1...\n`)
          newDdsLines = await conversionV1(newJsonSrcObj, originalDdsLines)
          break
        case '1':
          logger.info(`${CONVERT_METHOD} is set to '1', converting with V1...\n`)
          newDdsLines = await conversionV1(newJsonSrcObj, originalDdsLines)
          break
        default:
          throw Error(`Environment Variable ${CONVERT_METHOD} has an unexpected value '${process.env[CONVERT_METHOD]}'.`)
      }

      // Write the output file
      if (isDdsFile) {
        let outDir = await fsPromises.mkdtemp(join(tmpdir(), 'profound-utils-'))
          .then(result => result)
          .catch(err => Promise.reject(err))

        const parts = parse(inJson)
        const outputFile = `${outDir}${sep}${parts.name}.dspf`

        logger.info(`Writing temp file ${outputFile} ...`)
        await fsPromises.writeFile(outputFile, newDdsLines.join(CRLF))

        logger.info(`Writing output IBM i Source file ${srcLib}/${srcFile}.${srcMbr} ...`)
        await writeIbmISrcMbr(outputFile, srcFile, srcLib, srcMbr, newJsonSrcObj.text)

        return outputFile
      } else {
        logger.info(`Writing output file ${srcFile} ...`)
        await fsPromises.writeFile(srcFile, newDdsLines.join(CRLF))
        return srcFile
      }
    }
  } catch (error) {
    return Promise.reject(error)
  }
}

if (require.main.filename !== module.filename) {
} else if (process.argv.includes('--help') || process.argv.includes('?')) {
  logger.info(`jsonToDds - This tool will convert an existing JSON-based DSPF into DDS`)
  logger.info(`            format. This will allow you to convert a DSPF back to native`)
  logger.info(`            format for compile on IBM i.\n`)
  logger.info(`Usage : jsonToDds input-JSON-file output-DDS-file [output-library] [output-member]`)
} else if (process.argv.length > 9) {
  logger.error(`Too many parameters were specified.\n`)
  logger.info(`Usage : jsonToDds input-JSON-file output-DDS-file [output-library] [output-member]`)
} else if (process.argv.length !== 4 && process.argv.length < 6) {
  logger.error(`Too few parameters were specified.\n`)
  logger.info(`Usage : jsonToDds input-JSON-file output-DDS-file [output-library] [output-member]`)
} else {
  const inJsonFile = process.argv[2]
  const outFil = process.argv[3]
  const outLib = process.argv[4]
  const outMbr = process.argv[5]
  const srcFilOrig = process.argv[6];
  const srcLibOrig = process.argv[7];
  const srcMbrOrig = process.argv[8];

  main(inJsonFile, outFil, outLib, outMbr, srcFilOrig, srcLibOrig, srcMbrOrig)
    .then(result =>
      logger.info(`JSON file ${inJsonFile} was converted successfully.\n`)
    )
    .catch(err => {
      logger.error(`${err}\n`)
    })
}

exports.convert = main
