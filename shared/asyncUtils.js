'use strict'

const { join, sep } = require('path')
const { type, tmpdir } = require('os')
const { promises: fsPromises } = require('fs')
const pino = require('pino')

const logger = pino({
  prettyPrint: {
    colorize: true,
    ignore: 'time,pid,hostname'
  },
  level: process.env.LOG_LEVEL || 'info'
})

/**
 * @description Gets a new DBPool object.
 * @returns {Promise<Object>} The DBPool object.
 * @since 1.0.0
 */
const getDBPool = async () => {
  logger.debug('getDBPool() started with : ')

  const { DBPool } = require('idb-pconnector')

  const database = { url: '*LOCAL' }
  const config = { incrementSize: 2, debug: process.env.LOG_LEVEL === 'debug' }

  return new DBPool(database, config)
}

/**
 * @description Directly execute a statement by providing the SQL to the runSql() function.
 * @param {String} inSql The SQL statement to run (not for CALL of stored procedures).
 * @returns {Promise<String | Object>} The SQL results.
 * @since 1.0.0
 */
const runSql = async inSql => {
  logger.debug('runSql() started with : ', typeof inSql, 'inSql =', inSql)

  const pool = await getDBPool()

  return pool.runSql(inSql)
}

/**
 * @description Prepare and execute an SQL statement.
 * @param {String} inSql The SQL statement to prepare & execute.
 * @param {String | [String]} inParams The SQL parameters to be passed. The order of the parameters indexed in the array should map to the order of the parameter markers.
 * @returns {Promise<String | Object>} The SQL results.
 * @since 1.0.0
 */
const execSql = async (inSql, inParams) => {
  logger.debug('execSql() started with : ', typeof inSql, 'inSql =', inSql, ', ', typeof inParams, 'inParams =', inParams)

  const pool = await getDBPool()

  let params
  if (typeof inParams === 'string') {
    params = [inParams]
  }

  return pool.prepareExecute(inSql, params)
}

/**
 * @description Reads an IBM i source-physical file member.
 * @param {String} fil The Source-physical file.
 * @param {String} lib The Library containing the Source-physical file.
 * @param {String} mbr The source Member.
 * @param {String} [rtnFormat='stream'] (Optional) 'stream' returns a data stream of the Source Member.
 *                                                 'file' returns a file name containing the Source data.
 * @returns {Promise<String>} The stream of the source member.
 * @since 1.0.0
 */
const readIbmISrcMbr = async (fil, lib, mbr, rtnFormat) => {
  try {
    logger.debug('readIbmISrcMbr() started with : ', typeof fil, 'fil =', fil, ', ', typeof lib, 'lib =', lib, ', ', typeof mbr, 'mbr =', mbr, ', ', typeof rtnFormat, 'rtnFormat =', rtnFormat)

    // Check if this is IBM i
    if (type() !== 'OS400') {
      throw Error('readIbmISrcMbr() can only be called on IBM i.')
    }

    lib = lib.toUpperCase()
    fil = fil.toUpperCase()
    mbr = mbr.toUpperCase()

    // Copy the Member to a temp stream file
    const outDir = await fsPromises.mkdtemp(join(tmpdir(), 'profound-utils-'))

    const ifsStreamFile = `${outDir}${sep}${lib}.${fil}.${mbr}.dspf`

    const srcFile = lib + '/' + fil + ' ' + mbr

    const cpyStmt = `CPYTOIMPF FROMFILE(${srcFile}) TOSTMF('${ifsStreamFile}') MBROPT(*REPLACE) FROMCCSID(*FILE) STMFCCSID(1208) RCDDLM(*CRLF) DTAFMT(*FIXED) RMVBLANK(*EOR)`

    await execSql('CALL QCMDEXC(?)', cpyStmt)

    if (typeof rtnFormat === 'string' && rtnFormat === 'file') {
      return ifsStreamFile
    } else {
      const streamData = await fsPromises.readFile(ifsStreamFile, 'utf8')

      fsPromises.unlink(ifsStreamFile)
        .then(x => fsPromises.rmdir(outDir))

      return streamData
    }
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Gets a list of IBM i Members for Generic searches.
 * @param {String} fil The Source-physical file.
 * @param {String} lib The Library containing the Source-physical file.
 * @param {String} mbr The Source Member names to search for. This expects a name like 'ABC*'.
 * @returns {Promise<String[]>} Array of Member names matching the supplied IBM i member name.
 * @since 1.0.0
 */
const getIbmIMemberList = async (fil, lib, mbr) => {
  try {
    logger.debug('getIbmIMemberList() started with : ', typeof fil, 'fil =', fil, ', ', typeof lib, 'lib =', lib, ', ', typeof mbr, 'mbr =', mbr)

    lib = lib.toUpperCase()
    fil = fil.toUpperCase()
    mbr = mbr.toUpperCase()

    const sqlStmt = `select rtrim(system_table_member) as member from QSYS2.SYSPARTITIONSTAT where ` +
      `system_table_schema = '${lib}' and ` +
      `system_table_name = '${fil}' and ` +
      `system_table_member like '${mbr.replace('*', '%')}' ` +
      'order by system_table_member'

    const result = await runSql(sqlStmt)
    if (result.length === 0) {
      return []
    } else {
      return result.flatMap(arr => arr.MEMBER)
    }
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Gets the IBM i Member text.
 * @param {String} fil The Source-physical file.
 * @param {String} lib The Library containing the Source-physical file.
 * @param {String} mbr The source Member.
 * @returns {Promise<String>} The Member Text for the supplied IBM i member.
 * @since 1.0.0
 */
const getIbmIMemberText = async (fil, lib, mbr) => {
  try {
    logger.debug('getIbmIMemberText() started with : ', typeof fil, 'fil =', fil, ', ', typeof lib, 'lib =', lib, ', ', typeof mbr, 'mbr =', mbr)

    lib = lib.toUpperCase()
    fil = fil.toUpperCase()
    mbr = mbr.toUpperCase()

    const sqlStmt = `select PARTITION_TEXT from QSYS2.SYSPARTITIONSTAT where ` +
      `system_table_schema = '${lib}' and ` +
      `system_table_name = '${fil}' and ` +
      `system_table_member = '${mbr}'`

    const result = await runSql(sqlStmt)
    if (result.length === 0) {
      return Promise.reject(Error(`Unable to retrieve Member Text for ${lib}/${fil}.${mbr}.`))
    } else {
      return result[0].PARTITION_TEXT
    }
  } catch (error) {
    return Promise.reject(error)
  }
}

/**
 * @description Tests to see if the Source member exists in the Library and File that is passed.
 * @param {String} fil The Source File name.
 * @param {String} lib The Library containing the Source File.
 * @param {String} mbr The Source member name to verify.
 * @returns {Promise<String>} The error message if we reject.
 * @since 1.0.0
 */
const isValidDdsMember = async (fil, lib, mbr) => {
  logger.debug('isValidDdsMember() started with : ', typeof fil, 'fil =', fil, ', ', typeof lib, 'lib =', lib, ', ', typeof mbr, 'mbr =', mbr)

  const err = await getIbmIMemberText(fil, lib, mbr)
    .then(() => null)
    .catch(() => `Source Member '${mbr}' not found in file ${lib}/${fil}.`)

  if (err) {
    return Promise.reject(err)
  }
}

/**
 * @description Tests to see if this is a valid Source file name or not.
 * @param {String} fil The Source File name.
 * @param {String} lib The Library containing the Source File.
 * @returns {Promise<String>} The error message if we reject.
 * @since 1.0.0
 */
const isValidDdsSourceFile = async (fil, lib) => {
  logger.debug('isValidDdsSourceFile() started with : ', typeof fil, 'fil =', fil, ', ', typeof lib, 'lib =', lib)

  const sqlStmt = `select 1 from QSYS2.SYSTABLES ` +
    `where SYSTEM_TABLE_SCHEMA = '${lib}' ` +
    `and SYSTEM_TABLE_NAME = '${fil}'` +
    `and FILE_TYPE = 'S' ` +
    `fetch first 1 rows only`

  const err = await runSql(sqlStmt)
    .then(result => result.length === 0 ? `Source File '${fil}' not found in Library '${lib}'.` : null)
    .catch(error => error)

  if (err) {
    return Promise.reject(err)
  }
}

/**
 * @description Tests to see if this is a valid Library name or not.
 * @param {String} lib The Library containing the Source File.
 * @returns {Promise<String>} The error message if we reject.
 * @since 1.0.0
 */
const isValidLibrary = async lib => {
  logger.debug('isValidLibrary() started with : ', typeof lib, 'lib =', lib)

  const sqlStmt = `select 1 from QSYS2.SYSSCHEMAS ` +
    `where SYSTEM_SCHEMA_NAME = '${lib}' ` +
    `fetch first 1 rows only`

  const err = await runSql(sqlStmt)
    .then(result => result.length === 0 ? `Library '${lib}' not found on this system.` : null)
    .catch(error => error)

  if (err) {
    return Promise.reject(err)
  }
}

/**
 * @description Splits HTML data section in DDS files into smaller chunks to avoid DDS compiler issues.
 *              This routine is copied from ProfoundUI (/designer/dspf/RecordFormats.js 4a15d2a835eb3ebb8380fe2959656c1c0f17691c).
 *              No changes made here, other than making async and fixing linting issues.
 * @param {String} data The HTML data to split into chunks.
 * @param {Number} bytes The HTML data to split into chunks.
 * @returns {Promise<String[]>} The array of HTML chunks.
 * @since 1.0.0
 */
const chunkData = async (data, bytes) => {
  const chunks = []
  let count = 0
  const fixSingleQuotes = () => {
    if (count > 1) {
      // first character should not be a single quote
      // this can cause problems if the encoded single quote is split up
      // instead, we move the single quote to the previous chunk
      while (chunks[count - 1].substr(0, 1) === "'") {
        chunks[count - 1] = chunks[count - 1].substr(1)
        chunks[count - 2] += "'"
      }
    }
  }
  while (data.length > bytes) {
    // don't split into a chunk that has trailing blanks,
    // this doesn't work properly in SDA.
    var chunkSize = bytes
    while (chunkSize > 0 && data.substr(chunkSize - 1, 1) === ' ') chunkSize--
    if (chunkSize === 0) chunkSize = bytes
    chunks.push(data.substr(0, chunkSize))
    count++
    fixSingleQuotes()
    data = data.substr(chunkSize)
  }
  if (data.length > 0) {
    chunks.push(data)
    count++
    fixSingleQuotes()
  }
  return chunks
}

exports.runSql = runSql
exports.execSql = execSql
exports.readIbmISrcMbr = readIbmISrcMbr
exports.getIbmIMemberText = getIbmIMemberText
exports.isValidDdsMember = isValidDdsMember
exports.isValidDdsSourceFile = isValidDdsSourceFile
exports.isValidLibrary = isValidLibrary
exports.getIbmIMemberList = getIbmIMemberList
exports.chunkData = chunkData
