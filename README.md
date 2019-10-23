# Profound Utils
A collection of Profound Utils, to help simplify tasks in various Profound products.

## Table of Contents
- [**Getting Started**](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Installing Profound Utils](#installing-profound-utils)
    - [Listing the Utils](#listing-the-utils)
    - [Getting Help](#getting-help)
- [**Utils**](#utils)
    - [DDS/JSON Conversion Verifier](#ddsjson-conversion-verifier)
    - [DDS to JSON display-file converter](#dds-to-json-display-file-converter)
    - [JSON to DDS Rich Display File converter](#json-to-dds-rich-display-file-converter)
- [**Recommended Setup for Mass-Conversions**](#recommended-setup-for-mass-conversions)
- [**Issues**](#issues)
- [**Built With**](#built-with)
- [**Versioning**](#versioning)
- [**Authors**](#authors)
- [**License**](#license)
- [**Acknowledgements**](#acknowledgements)


## Getting Started

These instructions will get you a copy of the project up and running on your machine.

### Prerequisites

You will need to have [Node.js](https://nodejs.org/en/) installed in order to run these utilities.

### Installing Profound Utils

Decide where you want to install these utils. Maybe your Home folder?

```
$ cd ~
```

Now you just need to clone this repository from Github

```
$ git clone git@github.com:ProfoundLogic/profound-utils.git
```

Then you can change your current folder into this folder

```
$ cd profound-utils
```

### Listing the Utils
You can issue the following command to get a list of Utility commands currently available. Please see each section of this README for a detailed description on each utility.

```
$ node .
```

### Getting Help
You can type the following on each utility to get additional help information
```
$ node <utility-name> --help
```
or
```
$ node <utility-name> ?
```

# Utils

## DDS/JSON Conversion Verifier

This utility will check for any unexpected DDS issues, by running two consecutive conversions to verify the DDS conversion logic. It will take parameters for the initial DDS input, then run the DDS->JSON converter, and then the JSON->DDS converter. It then compares the new DDS source back to the original DDS source, and reports any discrepancies.


### Syntax

```
$ node verifyConvert input-DDS-file [input-library] [input-member]
```

### Parameter Descriptions
    input-DDS-file
        This is the Input DDS source to verify. It can be a Source Physical File (e.g. QDDSSRC), or a path-based file name.

    [input-library]
        (Optional). If input-DDS-file is a Source Physical File, then this is required, and specifies the Library containing the Source Physical File.

    [input-member]
        (Optional). If input-DDS-file is a Source Physical File, then this is required, and specifies the Member Name that contains the DDS data for conversion. 

## DDS to JSON display-file converter

This utility will convert an existing DDS source-based Display File into JSON format. This will allow you to realize many advantages over the DDS version, such as performing mass Find/Replace changes in your favorite Source editor, moving the screen to a Git repository for change control, etc.

### Syntax

```
$ node ddsToJson output-directory input-DDS-file [input-library] [input-member]
```

### Parameter Descriptions
    output-directory
        The Output Directory where the converted JSON file will be created. This Output Directory must exist and have write permissions. The converted file will be named as LIBRARY.FILE.MEMBER.json

    input-DDS-file
        This is the Input DDS file that contains the DDS data you want to convert.
        It can be a Source Physical File (e.g. QDDSSRC), or a path-based file name.

    [input-library]
        (Optional). If input-DDS-file is a Source Physical File, then this is required, and specifies the Library containing the Source Physical File.

    [input-member]
        (Optional). If input-DDS-file is a Source Physical File, then this is required, and specifies the Member Name that contains the DDS data for conversion. 

## JSON to DDS Rich Display File converter

This utility will convert an existing JSON-based Rich Display File into DDS format. This will allow you to convert JSON files back into native DDS format, ready for compile and/or testing.

### Syntax

```
$ node jsonToDds input-JSON-file output-DDS-file [output-library] [output-member]
```

### Parameter Descriptions

    input-JSON-file
        This is the Input JSON file to be converted into DDS format.

    output-DDS-file
        This is the Output file name. It can be a Source Physical File, or a path-based file name. If this is a Source Physical File, it must exist.

    [output-library]
        (Optional). If output-DDS-file is a Source Physical File, then this is required, and specifies the Library containing the Source Physical File. The Library must exist.

    [output-member]
        (Optional). If output-DDS-file is a Source Physical File, then this is required, and specifies the Member Name that will be created to contain the converted DDS data. The Member must NOT exist, to prevent accidentally overwriting existing data.


## Recommended Setup for Mass-Conversions

Maybe you have a lot of DDS Source members you want to convert? You could add a PDM User-Defined Option to assist with converting multiple/all members in a DDS Source file.

The syntax for this is as follows
```
Option  . . . . . . . . .   DJ   Option to create
Command . . . . . . . . .   qsh CMD('node /path/to/utils/repo/profound-utils/ddsToJson.js /absolute/path/to/output-directory-name &F &L &N')
```

In order for this to run correctly, your current job must have the following Environment Variable set to Allow Multiple Threads
```
Name  . . . . . . . . . :   QIBM_MULTI_THREADED
Value . . . . . . . . . :   'Y'
```

You may want to prevent Interactive Shell Command Output from interrupting each request
```
Name  . . . . . . . . . :   QIBM_QSH_CMD_OUTPUT
Value . . . . . . . . . :   'NONE'
```

## Issues
Any issues or feature requests should be logged [here.](https://github.com/ProfoundLogic/profound-utils/issues)


## Built With

* [Standard](https://standardjs.com/) - JavaScript Standard Style
* [idb-pconnector](https://github.com/IBM/nodejs-idb-pconnector/) - Promise-based DB2 Connector for IBM i
* [pino](http://getpino.io/#/) - Node.js logger, inspired by Bunyan


## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/ProfoundLogic/profound-utils/tags).

## Authors
* **Andy Fox** - *DDS/JSON Conversion Verifier* - [Profound Logic](https://github.com/ProfoundLogic)
* **Andy Fox** - *DDS to JSON* - [Profound Logic](https://github.com/ProfoundLogic)
* **Andy Fox** - *JSON to DDS* - [Profound Logic](https://github.com/ProfoundLogic)

See also the list of [contributors](https://github.com/ProfoundLogic/profound-utils/graphs/contributors) who participated in this project.

## License

You must purchase a Profound UI or a Profound.js license to use this repository.

## Acknowledgements

* A great README template from [PurpleBooth.](https://gist.github.com/PurpleBooth/109311bb0361f32d87a2)
