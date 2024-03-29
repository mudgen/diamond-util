/* global ethers */

const FacetCutAction = {
  Add: 0,
  Replace: 1,
  Remove: 2
}

// supports optional logging. returns
// a noop if logging is silenced
function getLogger(silenced = false) {
  return silenced ? function () {} : console.log;
}

// eslint-disable-next-line no-unused-vars
function getSignatures (contract) {
  return Object.keys(contract.interface.functions)
}

function getSelectors (contract) {
  const signatures = Object.keys(contract.interface.functions)
  const selectors = signatures.reduce((acc, val) => {
    if (val !== 'init(bytes)') {
      acc.push(contract.interface.getSighash(val))
    }
    return acc
  }, [])
  return selectors
}

async function deployFacets (facets, silenceLogs = false) {
  const log = getLogger(silenceLogs);
  log('--')
  const deployed = []
  for (const facet of facets) {
    if (Array.isArray(facet)) {
      if (typeof facet[0] !== 'string') {
        throw Error(`Error using facet: facet name must be a string. Bad input: ${facet[0]}`)
      }
      if (!(facet[1] instanceof ethers.Contract)) {
        throw Error(`Error using facet: facet must be a Contract. Bad input: ${facet[1]}`)
      }
      log(`Using already deployed ${facet[0]}: ${facet[1].address}`)
      log('--')
      deployed.push(facet)
    } else {
      if (typeof facet !== 'string') {
        throw Error(`Error deploying facet: facet name must be a string. Bad input: ${facet}`)
      }
      const facetFactory = await ethers.getContractFactory(facet)
      log(`Deploying ${facet}`)
      const deployedFactory = await facetFactory.deploy()
      await deployedFactory.deployed()
      log(`${facet} deployed: ${deployedFactory.address}`)
      log('--')
      deployed.push([facet, deployedFactory])
    }
  }
  return deployed
}

async function deploy ({
  diamondName,
  facets,
  silenceLogs = false,
  args = [],
  overrides = {}
}) {
  if (arguments.length !== 1) {
    throw Error(`Requires only 1 map argument. ${arguments.length} arguments used.`)
  }
  const log = getLogger(silenceLogs);
  facets = await deployFacets(facets, silenceLogs)
  const diamondFactory = await ethers.getContractFactory(diamondName)
  const diamondCut = []
  log('--')
  log('Setting up diamondCut args')
  log('--')
  for (const [name, deployedFacet] of facets) {
    log(name)
    log(getSignatures(deployedFacet))
    log('--')
    diamondCut.push([
      deployedFacet.address,
      FacetCutAction.Add,
      getSelectors(deployedFacet)
    ])
  }
  log('--')
  log(`Deploying ${diamondName}`)
  const constructorArguments = [diamondCut]
  if (args.length > 0) {
    constructorArguments.push(args)
  }

  const deployedDiamond = await diamondFactory.deploy(...constructorArguments, overrides)
  await deployedDiamond.deployed()
  const result = await deployedDiamond.deployTransaction.wait()

  log(`${diamondName} deployed: ${deployedDiamond.address}`)
  log(`${diamondName} constructor arguments:`)
  log(JSON.stringify(constructorArguments, null, 4))
  if (!result.status) {
    log('TRANSACTION FAILED!!! -------------------------------------------')
    log('See block explorer app for details.')
  }
  log('Transaction hash:' + deployedDiamond.deployTransaction.hash)
  log('--')
  return deployedDiamond
}

function inFacets (selector, facets) {
  for (const facet of facets) {
    if (facet.functionSelectors.includes(selector)) {
      return true
    }
  }
  return false
}

async function upgrade ({
  diamondAddress,
  diamondCut,
  txArgs = {},
  silenceLogs = false,
  initFacetName = undefined,
  initArgs
}) {
  if (arguments.length !== 1) {
    throw Error(`Requires only 1 map argument. ${arguments.length} arguments used.`)
  }
  const log = getLogger(silenceLogs);
  const diamondCutFacet = await ethers.getContractAt('DiamondCutFacet', diamondAddress)
  const diamondLoupeFacet = await ethers.getContractAt('DiamondLoupeFacet', diamondAddress)
  const existingFacets = await diamondLoupeFacet.facets()
  const facetFactories = new Map()

  log('Facet Signatures and Selectors: ')
  for (const facet of diamondCut) {
    const functions = new Map()
    const selectors = []
    log('Facet: ' + facet)
    let facetName
    let contract
    if (Array.isArray(facet[0])) {
      facetName = facet[0][0]
      contract = facet[0][1]
      if (!(typeof facetName === 'string')) {
        throw Error('First value in facet[0] array must be a string.')
      }
      if (!(contract instanceof ethers.Contract)) {
        throw Error('Second value in facet[0] array must be a Contract object.')
      }
      facet[0] = facetName
    } else {
      facetName = facet[0]
      if (!(typeof facetName === 'string') && facetName) {
        throw Error('facet[0] must be a string or an array or false.')
      }
    }
    for (const signature of facet[2]) {
      const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10)
      log(`Function: ${selector} ${signature}`)
      selectors.push(selector)
      functions.set(selector, signature)
    }
    log('')
    if (facet[1] === FacetCutAction.Remove) {
      if (facetName) {
        throw (Error(`Can't remove functions because facet name must have a false value not ${facetName}.`))
      }
      facet[0] = ethers.constants.AddressZero
      for (const selector of selectors) {
        if (!inFacets(selector, existingFacets)) {
          const signature = functions.get(selector)
          throw Error(`Can't remove '${signature}'. It doesn't exist in deployed diamond.`)
        }
      }
      facet[2] = selectors
    } else if (facet[1] === FacetCutAction.Replace) {
      let facetFactory = facetFactories.get(facetName)
      if (!facetFactory) {
        if (contract) {
          facetFactories.set(facetName, contract)
        } else {
          facetFactory = await ethers.getContractFactory(facetName)
          facetFactories.set(facetName, facetFactory)
        }
      }
      for (const signature of facet[2]) {
        if (!Object.prototype.hasOwnProperty.call(facetFactory.interface.functions, signature)) {
          throw (Error(`Can't replace '${signature}'. It doesn't exist in ${facetName} source code.`))
        }
      }
      for (const selector of selectors) {
        if (!inFacets(selector, existingFacets)) {
          const signature = functions.get(selector)
          throw Error(`Can't replace '${signature}'. It doesn't exist in deployed diamond.`)
        }
      }
      facet[2] = selectors
    } else if (facet[1] === FacetCutAction.Add) {
      let facetFactory = facetFactories.get(facetName)
      if (!facetFactory) {
        if (contract) {
          facetFactories.set(facetName, contract)
        } else {
          facetFactory = await ethers.getContractFactory(facetName)
          facetFactories.set(facetName, facetFactory)
        }
      }
      for (const signature of facet[2]) {
        if (!Object.prototype.hasOwnProperty.call(facetFactory.interface.functions, signature)) {
          throw (Error(`Can't add ${signature}. It doesn't exist in ${facetName} source code.`))
        }
      }
      for (const selector of selectors) {
        if (inFacets(selector, existingFacets)) {
          const signature = functions.get(selector)
          throw Error(`Can't add '${signature}'. It already exists in deployed diamond.`)
        }
      }
      facet[2] = selectors
    } else {
      throw (Error('Incorrect FacetCutAction value. Must be 0, 1 or 2. Value used: ' + facet[1]))
    }
  }
  // deploying new facets
  const alreadDeployed = new Map()
  for (const facet of diamondCut) {
    if (facet[1] !== FacetCutAction.Remove) {
      const existingAddress = alreadDeployed.get(facet[0])
      if (existingAddress) {
        facet[0] = existingAddress
        continue
      }
      log(`Deploying ${facet[0]}`)
      const facetFactory = facetFactories.get(facet[0])
      let deployedFacet = facetFactory
      if (!(deployedFacet instanceof ethers.Contract)) {
        deployedFacet = await facetFactory.deploy()
        await deployedFacet.deployed()
      }
      facetFactories.set(facet[0], deployedFacet)
      log(`${facet[0]} deployed: ${deployedFacet.address}`)
      alreadDeployed.set(facet[0], deployedFacet.address)
      facet[0] = deployedFacet.address
    }
  }

  log('diamondCut arg:')
  log(diamondCut)

  let initFacetAddress = ethers.constants.AddressZero
  let functionCall = '0x'
  if (initFacetName !== undefined) {
    let initFacet = facetFactories.get(initFacetName)
    if (!initFacet) {
      const InitFacet = await ethers.getContractFactory(initFacetName)
      initFacet = await InitFacet.deploy()
      await initFacet.deployed()
      log('Deployed init facet: ' + initFacet.address)
    } else {
      log('Using init facet: ' + initFacet.address)
    }
    functionCall = initFacet.interface.encodeFunctionData('init', initArgs)
    log('Function call: ')
    log(functionCall)
    initFacetAddress = initFacet.address
  }

  const result = await diamondCutFacet.diamondCut(
    diamondCut,
    initFacetAddress,
    functionCall,
    txArgs
  )
  const receipt = await result.wait()
  if (!receipt.status) {
    log('TRANSACTION FAILED!!! -------------------------------------------')
    log('See block explorer app for details.')
  }
  log('------')
  log('Upgrade transaction hash: ' + result.hash)
  return result
}

async function upgradeWithNewFacets ({
  diamondAddress,
  facetNames,
  selectorsToRemove = [],
  silenceLogs = false,
  initFacetName = undefined,
  initArgs = []
}) {
  if (arguments.length === 1) {
    throw Error(`Requires only 1 map argument. ${arguments.length} arguments used.`)
  }
  const log = getLogger(silenceLogs);
  const diamondCutFacet = await ethers.getContractAt('DiamondCutFacet', diamondAddress)
  const diamondLoupeFacet = await ethers.getContractAt('DiamondLoupeFacet', diamondAddress)

  const diamondCut = []
  const existingFacets = await diamondLoupeFacet.facets()
  const undeployed = []
  const deployed = []
  for (const name of facetNames) {
    log(name)
    const facetFactory = await ethers.getContractFactory(name)
    undeployed.push([name, facetFactory])
  }

  if (selectorsToRemove.length > 0) {
    // check if any selectorsToRemove are already gone
    for (const selector of selectorsToRemove) {
      if (!inFacets(selector, existingFacets)) {
        throw Error('Function selector to remove is already gone.')
      }
    }
    diamondCut.push([
      ethers.constants.AddressZeo,
      FacetCutAction.Remove,
      selectorsToRemove
    ])
  }

  for (const [name, facetFactory] of undeployed) {
    log(`Deploying ${name}`)
    deployed.push([name, await facetFactory.deploy()])
  }

  for (const [name, deployedFactory] of deployed) {
    await deployedFactory.deployed()
    log('--')
    log(`${name} deployed: ${deployedFactory.address}`)
    const add = []
    const replace = []
    for (const selector of getSelectors(deployedFactory)) {
      if (!inFacets(selector, existingFacets)) {
        add.push(selector)
      } else {
        replace.push(selector)
      }
    }
    if (add.length > 0) {
      diamondCut.push([deployedFactory.address, FacetCutAction.Add, add])
    }
    if (replace.length > 0) {
      diamondCut.push([
        deployedFactory.address,
        FacetCutAction.Replace,
        replace
      ])
    }
  }
  log('diamondCut arg:')
  log(diamondCut)
  log('------')

  let initFacetAddress = ethers.constants.AddressZero
  let functionCall = '0x'
  if (initFacetName !== undefined) {
    let initFacet
    for (const [name, deployedFactory] of deployed) {
      if (name === initFacetName) {
        initFacet = deployedFactory
        break
      }
    }
    if (!initFacet) {
      const InitFacet = await ethers.getContractFactory(initFacetName)
      initFacet = await InitFacet.deploy()
      await initFacet.deployed()
      log('Deployed init facet: ' + initFacet.address)
    } else {
      log('Using init facet: ' + initFacet.address)
    }
    functionCall = initFacet.interface.encodeFunctionData('init', initArgs)
    log('Function call: ')
    log(functionCall)
    initFacetAddress = initFacet.address
  }

  const result = await diamondCutFacet.diamondCut(
    diamondCut,
    initFacetAddress,
    functionCall
  )
  log('------')
  log('Upgrade transaction hash: ' + result.hash)
  return result
}

exports.FacetCutAction = FacetCutAction
exports.upgrade = upgrade
exports.upgradeWithNewFacets = upgradeWithNewFacets
exports.getSelectors = getSelectors
exports.deployFacets = deployFacets
exports.deploy = deploy
exports.inFacets = inFacets
exports.upgrade = upgrade
