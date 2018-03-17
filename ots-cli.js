#!/usr/bin/env node

// Dependencies
const fs = require('fs')
const program = require('commander')
const OpenTimestamps = require('./src/open-timestamps.js')
const Utils = require('./src/utils.js')
const DetachedTimestampFile = require('./src/detached-timestamp-file.js')
const Ops = require('./src/ops.js')
const Context = require('./src/context.js')

// Constants
const path = process.argv[1].split('/')
const title = path[path.length - 1]
let isExecuted = false

// Parse parameters

function collect (val, memo) {
  memo.push(val)
  return memo
}

program
  .version(require('./package.json').version)

const infoCommand = program
  .command('info [FILE_OTS]')
  .alias('i')
  .option('-v, --verbose', 'Be more verbose.')
  .description('Show information on a timestamp.')
  .action((file, options) => {
    isExecuted = true
    if (!file) {
      console.log(infoCommand.helpInformation())
      return
    }
    info(file, options)
  })

const stampCommand = program
  .command('stamp [FILE...]')
  .alias('s')
  .option('-c, --calendar [url]', 'Create timestamp with the aid of a remote calendar. May be specified multiple times', collect, [])
  .option('-m <int>', 'Commitments are sent to remote calendars in the event of timeout the timestamp is considered done if at least M calendars replied')
  .option('-k, --key <file>', 'Signature key file of private remote calendars')
  .option('-d, --digest <digest>', 'Verify a (hex-encoded) digest rather than a file')
  .option('-a, --algorithm <type>', 'Hash algorithm: sha1, sha256 (default), ripemd160')
  .description('Create timestamp with the aid of a remote calendar, the output receipt will be saved with .ots')
  .action((files, options) => {
    isExecuted = true
    if ((files === undefined || files.length < 1) && !options.digest) {
      console.log(stampCommand.helpInformation())
      return
    }

    const parameters = {}
    if (options.calendar) {
      parameters.publicCalendars = options.calendar
    }
    if (options.key) {
      parameters.privateCalendars = Utils.readSignatureFile(options.key)
    }
    if (options.m) {
      parameters.m = options.m
    }
    if (options.digest) {
      parameters.digest = options.digest
    }

    if (options.algorithm === undefined) {
      parameters.algorithm = 'sha256'
    } else if (['sha1', 'sha256', 'ripemd160'].indexOf(options.algorithm.toLowerCase()) > -1) {
      parameters.algorithm = options.algorithm.toLowerCase()
    } else {
      console.log('Create timestamp with the aid of a remote calendar.')
      console.log(title + ' stamp: ' + options.algorithm + ' unsupported ')
      return
    }

    stamp(files, parameters)
  })

const verifyCommand = program
  .command('verify [FILE_OTS]')
  .alias('v')
  .option('-f, --file <file>', 'Specify target file explicitly (default: original file present in the same directory without .ots)')
  .option('-d, --digest <digest>', 'Verify a (hex-encoded) digest rather than a file')
  .option('-a, --algorithm <type>', 'Hash algorithm: sha1, sha256 (default), ripemd160')
  .description('Verify a timestamp')
  .action((file, options) => {
    isExecuted = true
    if (!file) {
      console.log(verifyCommand.helpInformation())
      return
    }
    if (options.algorithm === undefined) {
      options.algorithm = 'sha256'
    } else if (['sha1', 'sha256', 'ripemd160'].indexOf(options.algorithm.toLowerCase()) > -1) {
      options.algorithm = options.algorithm.toLowerCase()
    } else {
      console.log('Create timestamp with the aid of a remote calendar.')
      console.log(title + ' stamp: ' + options.algorithm + ' unsupported ')
      return
    }

    verify(file, options)
  })

const upgradeCommand = program
  .command('upgrade [FILE_OTS]')
  .alias('u')
  .option('-c, --calendar [url]', 'Override calendars in timestamp', collect, [])
  .description('Upgrade remote calendar timestamps to be locally verifiable')
  .action((file, options) => {
    isExecuted = true
    if (!file) {
      console.log(upgradeCommand.helpInformation())
      return
    }
    upgrade(file, options)
  })

program.parse(process.argv)

if (!isExecuted) {
  console.log(program.helpInformation())
}

// FUNCTIONS
function info (argsFileOts, options) {
  const otsPromise = Utils.readFilePromise(argsFileOts, null)

  Promise.all([otsPromise]).then(values => {
    const ots = values[0]

    try {
      const detachedOts = DetachedTimestampFile.deserialize(ots)
      const infoResult = OpenTimestamps.info(detachedOts, options)
      console.log(infoResult)
    } catch (err) {
      if (err instanceof Context.BadMagicError) {
        throw new Error('Error! ' + argsFileOts + ' is not a timestamp file.')
      } else if (err instanceof Context.DeserializationError) {
        throw new Error('Invalid timestamp file ' + argsFileOts)
      } else {
        throw err
      }
    }
  }).catch(err => {
    if (err.code === 'ENOENT') {
      console.error('File not found \'' + err.path + '\'')
    } else {
      console.error(err.message)
    }
    process.exit(1)
  })
}

function stamp (argsFiles, options) {
  // check input params : file/hash
  const filePromises = []
  if (options.digest) {
    // digest: convert to bytes
    filePromises.push(Utils.hexToBytes(options.digest))
  } else {
    // file: read file in bytes format
    argsFiles.forEach(argsFile => {
      filePromises.push(Utils.readFilePromise(argsFile, null))
    })
  }

  // check input params : algorithm
  let op = new Ops.OpSHA256()
  if (options.algorithm === 'sha1') {
    op = new Ops.OpSHA1()
  } else if (options.algorithm === 'sha256') {
    op = new Ops.OpSHA256()
  } else if (options.algorithm === 'ripemd160') {
    op = new Ops.OpRIPEMD160()
  }

  // main promise
  Promise.all(filePromises).then(values => {
    const detaches = []
    values.forEach(value => {
      if (options.digest) {
        try {
          detaches.push(DetachedTimestampFile.fromHash(op, value))
        } catch (err) {
          throw new Error('Invalid hash ' + options.digest + ' for ' + options.algorithm)
        }
      } else {
        detaches.push(DetachedTimestampFile.fromBytes(op, value))
      }
    })

    OpenTimestamps.stamp(detaches, options).then(() => {
      if (detaches === undefined) {
        console.error('Invalid timestamp')
        return
      }

      detaches.forEach((ots, i) => {
        if (ots === undefined) {
          console.error('Invalid timestamp')
          return
        }

        let otsFilename
        if (options.digest) {
          otsFilename = options.digest + '.ots'
        } else {
          otsFilename = argsFiles[i] + '.ots'
        }
        const buffer = new Buffer(ots.serializeToBytes())
        saveOts(otsFilename, buffer)
      })
    }).catch(err => {
      console.error(err.message)
      process.exit(1)
    })
  }).catch(err => {
    if (err.code === 'ENOENT') {
      console.error('File not found \'' + err.path + '\'')
    } else {
      console.error(err.message)
    }
    process.exit(1)
  })
}

function saveOts (otsFilename, buffer) {
  fs.exists(otsFilename, fileExist => {
    if (fileExist) {
      console.log('The timestamp proof \'' + otsFilename + '\' already exists')
    } else {
      fs.writeFile(otsFilename, buffer, 'binary', err => {
        if (err) {
          return console.log(err)
        }
        console.log('The timestamp proof \'' + otsFilename + '\' has been created!')
      })
    }
  })
}

function verify (argsFileOts, options) {
  const files = []
  files.push(Utils.readFilePromise(argsFileOts, null))
  if (options.digest) {
    // input is a digest
    console.log('Assuming target hash is \'' + options.digest + '\'')
  } else if (options.file) {
    // defined input file
    console.log('Assuming target filename is \'' + options.file + '\'')
    files.push(Utils.readFilePromise(options.file, null))
  } else {
    // default input file
    const argsFile = argsFileOts.replace('.ots', '')
    console.log('Assuming target filename is \'' + argsFile + '\'')
    files.push(Utils.readFilePromise(argsFile, null))
  }

  Promise.all(files).then(values => {
    const fileOts = values[0]

    // Read ots file and check hash function
    let detachedOts
    try {
      detachedOts = DetachedTimestampFile.deserialize(fileOts)
    } catch (err) {
      if (err instanceof Context.BadMagicError) {
        throw new Error('Error! ' + argsFileOts + ' is not a timestamp file.')
      } else if (err instanceof Context.DeserializationError) {
        throw new Error('Invalid timestamp file ' + argsFileOts)
      } else {
        throw err
      }
    }

    // Read original file with same hash function of ots
    let detached
    if (options.digest) {
      try {
        detached = DetachedTimestampFile.fromHash(detachedOts.fileHashOp, Utils.hexToBytes(options.digest))
      } catch (err) {
        throw new Error('Invalid hash ' + options.digest + ' for ' + detachedOts.fileHashOp._HASHLIB_NAME())
      }
    } else {
      const file = values[1]
      detached = DetachedTimestampFile.fromBytes(detachedOts.fileHashOp, file)
    }

    // Opentimestamps verify
    const verifyPromise = OpenTimestamps.verify(detachedOts, detached)

    verifyPromise.then(results => {
      if (results && results.chain) {
        console.log('Success! ' + results.chain[0].toUpperCase() + results.chain.slice(1) + ' attests data existed as of ' + (new Date(results.attestedTime * 1000)))
      }
    }).catch(err => {
      console.log(err.message)
      process.exit(1)
    })
  }).catch(err => {
    if (err.code === 'ENOENT') {
      console.error('File not found \'' + err.path + '\'')
    } else {
      console.error(err.message)
    }
    process.exit(1)
  })
}

function upgrade (argsFileOts, options) {
  const otsPromise = Utils.readFilePromise(argsFileOts, null)
  otsPromise.then(ots => {
    let detachedOts

    try {
      detachedOts = DetachedTimestampFile.deserialize(ots)
    } catch (err) {
      if (err instanceof Context.BadMagicError) {
        throw new Error('Error! ' + argsFileOts + ' is not a timestamp file.')
      } else if (err instanceof Context.DeserializationError) {
        throw new Error('Invalid timestamp file ' + argsFileOts)
      } else {
        throw err
      }
    }

    const upgradePromise = OpenTimestamps.upgrade(detachedOts, options.calendar)
    upgradePromise.then(changed => {
      // check timestamp
      if (changed) {
        // console.log('Timestamp has been successfully upgraded!');
        fs.writeFile(argsFileOts + '.bak', new Buffer(ots), 'binary', err => {
          if (err) {
            return console.log(err)
          }
          console.log('The file .bak was saved!')
        })
        fs.writeFile(argsFileOts, new Buffer(detachedOts.serializeToBytes()), 'binary', err => {
          if (err) {
            return console.log(err)
          }
        })
      }
      if (detachedOts.timestamp.isTimestampComplete()) {
        console.log('Success! Timestamp complete')
      } else {
        console.log('Failed! Timestamp not complete')
      }
    }).catch(err => {
      console.log(err.message)
      process.exit(1)
    })
  }).catch(err => {
    if (err.code === 'ENOENT') {
      console.error('File not found \'' + err.path + '\'')
    } else {
      console.error(err.message)
    }
    process.exit(1)
  })
}
