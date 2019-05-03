const parser = require('solidity-parser-antlr');
const path = require('path');
const fs = require('fs');

const { transformForEdgeBundeling } = require('./graphics/edgebundeling');
const { transformForNeural } = require('./graphics/neural');

/**
 * Given a word, verifies if it's one from Solidity keyword calls
 * @param {strng} word statement to be verified
 */
function isKeywordCall(word) {
    return (word === 'length');
}

/**
 * Given word, verifies if it's one from Solidity keyword functions
 * @param {strng} word statement to be verified
 */
function isKeywordFunction(word) {
    return (word === 'require'
        || word === 'revert'
        || word === 'assert');
}

/**
 * Given a function object and a ignored list, validates it
 * @param {object} fLink the function object parsed
 * @param {array} ignoresList a list of ignored function calls
 */
function isCountableStatement(fLink, contractsList, ignoresList) {
    return (!isKeywordFunction(fLink.expression.name)
        && !ignoresList.includes(fLink.expression.name)
        && !contractsList.includes(fLink.expression.name)
        && fLink.expression.name !== undefined);
}

/**
 * Function containing parse methods used in parser.visit
 */
function parserFunctionVisitor(contractsList, ignoresList, fDef, callMethods) {
    return {
        FunctionCall: (functionCallNode) => {
            // in order to avoid override methods that only call the base method
            // let's verify if the expressions is different than the function
            // and if it's not the only one
            if (fDef.name !== functionCallNode.expression.name
                && fDef.body.statements.length > 1
                && isCountableStatement(functionCallNode, contractsList, ignoresList)) {
                // and if so, add to a list
                callMethods.push({ name: functionCallNode.expression.name, args: functionCallNode.arguments });
            }
        },
        MemberAccess: (functionCallNode) => {
            // sometimes, when calling a member from a library, for example
            if ((functionCallNode.expression.type !== 'Identifier'
                || contractsList.includes(functionCallNode.expression.name)
                || functionCallNode.expression.name === 'super')
                && functionCallNode.expression.type !== 'IndexAccess') {
                // sometimes, when calling something like
                // bytes(_tokenURIs[tokenId]).length it returns as a FunctionCall and then
                // functionCallNode.memberName turns to be "length"
                // So, in order to prevent it, let's do one last check
                if (isKeywordCall(functionCallNode.memberName)) {
                    return;
                }
                // and if so, add to a list
                const hasArguments = Object.prototype.hasOwnProperty
                    .call(functionCallNode.expression, 'arguments');
                if (hasArguments) {
                    callMethods.push({ name: functionCallNode.memberName, args: functionCallNode.expression.arguments });
                } else {
                    callMethods.push({ name: functionCallNode.memberName, args: [] });
                }
            }
        },
    };
}

/**
 * Parses the contract and organizes the data to make ready
 * to put in the graphic. This method is recursive
 * to support inheritance.
 * @param {string} solidityFile solidity file path
 * @param {array} importVisited list of visited contracts
 * @param {array} ignoresList list of ignored calls
 * @param {array} contractsList list of contracts names
 */
function processData(solidityFile, importVisited, ignoresList, contractsList) {
    let contractName;
    const methodCalls = [];
    const importList = [];
    const processed = [];
    const extendsContracts = [];
    // read file
    const input = fs.readFileSync(solidityFile).toString();
    // parse it using solidity-parser-antlr
    const ast = parser.parse(input);
    // and then navigate though all subnodes
    // it might look weird, but the reason to have separated each call in a new parse.visit
    // is because this definition are not called in this code order and instead called
    // in the order defined on the parser package
    // first we get the contract name and imports, the order is not relevant here
    parser.visit(ast, {
        ContractDefinition: (node) => {
            contractName = node.name;
        },
        ImportDirective: (node) => {
            // if, at any chance :joy: it inherits from another contract, then visit it
            let nodePath;
            // depending on the import type, build the path
            if (node.path[0] === '.') {
                nodePath = path.join(path.join(solidityFile, '../'), node.path);
            } else {
                nodePath = path.join(path.join(process.cwd(), 'node_modules'), node.path);
            }
            importList.push(nodePath);
        },
    });
    // then we navigate through all function definition
    // one of them might be a constructor and in case it calls other constructor
    // let's navigate through them
    parser.visit(ast, {
        FunctionDefinition: (fDef) => {
            // verify if they are functions and
            // if the node's body is empty (in case it's just a definition)
            if (fDef.isConstructor === true) {
                fDef.modifiers.forEach((modifier) => {
                    const nodePath = importList.filter(imp => imp.indexOf(modifier.name) > -1)[0];
                    if (!importVisited.includes(nodePath)) {
                        importVisited.push(nodePath);
                        const result = processData(
                            nodePath, importVisited, ignoresList, contractsList,
                        );
                        result.forEach(i => processed.push(i));
                    }
                });
            } else {
                // call methods
                const callMethods = [];
                if (fDef.body !== null) {
                    // some functions have empty bodies (like definitions)
                    // let's not visit them
                    // navigate through everything happening inside that function
                    parser.visit(fDef, parserFunctionVisitor(contractsList, ignoresList, fDef, callMethods));
                }
                // let's create a function definition using the contract name,
                // function name and parameters type
                let functionDefinition = `${contractName}:${fDef.name}`;
                fDef.parameters.parameters.forEach((p) => {
                    functionDefinition += `:${(p.typeName.name === undefined)
                        ? (p.typeName.namePath) : (p.typeName.name)}`;
                });
                // and if so, add to a list
                methodCalls.push({ functionName: fDef.name, functionDefinition, callMethods });
            }
        },
    });
    // then visit the not yet visited node according to "extends" order
    parser.visit(ast, {
        InheritanceSpecifier: (node) => {
            const nodePath = importList.filter(imp => imp.indexOf(node.baseName.namePath) > -1)[0];
            if (!importVisited.includes(nodePath)) {
                importVisited.push(nodePath);
                const result = processData(
                    nodePath, importVisited, ignoresList, contractsList,
                );
                result.forEach(i => processed.push(i));
            }
            extendsContracts.push(node.baseName.namePath);
        },
    });
    // in the end, visit the imports that were not visited yet
    // only visit if it was not visited. Used to ignore ciclyc calls
    importList.forEach((nodePath) => {
        if (importVisited.includes(nodePath)) {
            return;
        }
        importVisited.push(nodePath);
        const result = processData(
            nodePath, importVisited, ignoresList, contractsList,
        );
        result.forEach(i => processed.push(i));
    });
    processed.push({
        contractName, extendsContracts, importList, methodCalls,
    });
    return processed;
}

/**
 * Gets event definitions, structs and contract names
 * in order to process data with properly information
 * @param {string} solidityFile solidity file path
 * @param {array} importVisited list of visited contracts
 * @param {array} ignoresList list of ignored calls
 * @param {array} contractsList list of contracts names
 * @param {array} variableType map of variable and respective types
 */
function profileData(solidityFile, importVisited, ignoresList, contractsList, variableType) {
    let contractName = '';
    const contractVariables = new Map();
    // read file
    const input = fs.readFileSync(solidityFile).toString();
    // parse it using solidity-parser-antlr
    const ast = parser.parse(input);
    // first, we need to collect nodes to be ignored
    parser.visit(ast, {
        VariableDeclaration: (node) => {
            contractVariables.set(node.name, node);
        },
        EventDefinition: (node) => {
            // since events are also assumed has a function call
            // let's list them and ignore.
            ignoresList.push(node.name);
        },
        StructDefinition: (node) => {
            // since struct constructor are also assumed has a function call
            // let's list them and ignore.
            ignoresList.push(node.name);
        },
        ContractDefinition: (node) => {
            // also, we want to allow only member access
            // of contracts to be listed
            contractsList.push(node.name);
            contractName = node.name;
        },
        ImportDirective: (node) => {
            // if, at any chance :joy: it inherits from another contract, then visit it
            let nodePath;
            // depending on the import type, build the path
            if (node.path[0] === '.') {
                nodePath = path.join(path.join(solidityFile, '../'), node.path);
            } else {
                nodePath = path.join(path.join(process.cwd(), 'node_modules'), node.path);
            }
            if (!importVisited.includes(nodePath)) {
                importVisited.push(nodePath);
                profileData(
                    nodePath, importVisited, ignoresList, contractsList, variableType,
                );
            }
        },
    });
    variableType.set(contractName, contractVariables);
}

/**
 * Find and rename a given call in a given contract using the list of all contracts.
 * @param {object} contracts all contracts object for a specific contract (dependencies)
 * @param {object} contractInfo the contract info
 * @param {string} call the method name
 */
function findAndRenameCall(contracts, contractRoot, contractInfo, variableTypeMap, call) {
    if (contracts === undefined) {
        return undefined;
    }
    let foundResult;
    // first, search for that method in the same contract
    foundResult = contractInfo.methodCalls
        .find(method => method.functionName === call.name);
    if (foundResult !== undefined) {
        let functionDefinition = `${contractInfo.contractName}:${call.name}`;
        if (call.args !== undefined) {
            call.args.forEach((p) => {
                // if the argument is an indentifier, just add the type
                if (p.type === 'Identifier') {
                    // search for variable and get the type.
                    let argType;
                    // search names globally
                    // TODO: this should be improved!
                    variableTypeMap.forEach((valueVar) => {
                        valueVar.forEach((value, key) => {
                            if (key === p.name && argType === undefined) {
                                argType = (value.typeName.name === undefined)
                                    ? (value.typeName.namePath) : (value.typeName.name);
                            }
                        }, valueVar);
                    }, variableTypeMap);
                    functionDefinition += `:${argType}`;
                } else if (p.type === 'MemberAccess') {
                    // but in case it's a member access, there could be a few different things
                    // like msg.sender, msg.value, etc
                    if (p.memberName === 'sender') {
                        functionDefinition += ':address';
                    } else if (p.memberName === 'value') {
                        functionDefinition += ':uint256';
                    }
                }
            });
        }
        return functionDefinition;
    }
    // otherwise, let's look in parent contracts
    contractInfo.extendsContracts.forEach((extending) => {
        // look for it and visit
        const contractToVisit = contracts.find(c => c.contractName === extending);
        const result = findAndRenameCall(contracts, contractRoot,contractToVisit, variableTypeMap, call);
        if (result !== undefined) {
            foundResult = result;
        }
    });
    // if we didn't found in extend contracts, let's search over the imported
    // that are not in extend list
    if (foundResult === undefined) {
        contractInfo.importList.forEach((importContract) => {
            // take only the contract name
            const contractName = path.parse(importContract).name;
            // and if it's not in import list
            if (!contractInfo.extendsContracts.includes(contractName)) {
                // look for it and visit
                const contractToVisit = contracts.find(c => c.contractName === contractName);
                const result = findAndRenameCall(contracts, contractRoot, contractToVisit, variableTypeMap, call);
                if (result !== undefined) {
                    foundResult = result;
                }
            }
        });
    }
    return foundResult;
}

/**
 * Transform the method into a pseudo-link. As an example, transform `callMethods: [ 'method' ]`
 * in something line `callMethods: [ 'contract:method' ]` and so we know where is it going.
 * It looks for overriding methods.
 * @param {object} allContractsData all contracts data
 */
function renameToSymLinks(allContractsData, variableTypeMap) {
    allContractsData.forEach((contract) => {
        contract.contract.forEach((contractInfo) => {
            contractInfo.methodCalls.forEach((method) => {
                // update the call methods
                method.callMethods = method.callMethods.map((call) => {
                    call.name = findAndRenameCall(contract.contract, contractInfo, contractInfo, variableTypeMap, call);
                    return call;
                });
            });
        });
    });
    return allContractsData;
}

exports.parsing = (solidityFilesPath) => {
    let contractsArray = [];
    // first we process and organize data in order to have a standard
    const variableTypeMap = new Map();
    solidityFilesPath.forEach((file) => {
        // process data
        const ignoresList = [];
        const contractsList = [];
        profileData(file, [], ignoresList, contractsList, variableTypeMap);
        const contract = processData(file, [], ignoresList, contractsList);
        //
        contractsArray.push({ file, contract });
    });
    contractsArray = renameToSymLinks(contractsArray, variableTypeMap);
    // and then we transform from graphic
    contractsArray.forEach((dataElement) => {
        transformForEdgeBundeling(dataElement.file, dataElement.contract);
        transformForNeural(dataElement.file, dataElement.contract);
    });
};