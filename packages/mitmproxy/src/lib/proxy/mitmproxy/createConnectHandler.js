const net = require('net')
const url = require('url')
const log = require('../../../utils/util.log')
const DnsUtil = require('../../dns/index')
const localIP = '127.0.0.1'
const defaultDns = require('dns')
// const matchUtil = require('../../../utils/util.match')
const speedTest = require('../../speed/index.js')
function isSslConnect (sslConnectInterceptors, req, cltSocket, head) {
  for (const intercept of sslConnectInterceptors) {
    const ret = intercept(req, cltSocket, head)
    if (ret === false || ret === true) {
      return ret
    }
    // continue
  }
  return false
}

// create connectHandler function
module.exports = function createConnectHandler (sslConnectInterceptor, middlewares, fakeServerCenter, dnsConfig, sniConfig) {
  // return
  const sslConnectInterceptors = []
  sslConnectInterceptors.push(sslConnectInterceptor)
  for (const middleware of middlewares) {
    if (middleware.sslConnectInterceptor) {
      sslConnectInterceptors.push(middleware.sslConnectInterceptor)
    }
  }

  // log.info('sni config:', sniConfig)
  // const sniRegexpMap = matchUtil.domainMapRegexply(sniConfig)
  return function connectHandler (req, cltSocket, head) {
    // eslint-disable-next-line node/no-deprecated-api
    const { hostname, port } = url.parse(`https://${req.url}`)
    if (isSslConnect(sslConnectInterceptors, req, cltSocket, head)) {
      // 需要拦截，代替目标服务器，让客户端连接DS在本地启动的代理服务
      fakeServerCenter.getServerPromise(hostname, port).then((serverObj) => {
        log.info('--- fakeServer connect', hostname)
        connect(req, cltSocket, head, localIP, serverObj.port)
      }, (e) => {
        log.error('getServerPromise', e)
      })
    } else {
      log.info(`未匹配到任何 sslConnectInterceptors，不拦截请求，直接连接目标服务器: ${hostname}:${port}`)
      connect(req, cltSocket, head, hostname, port, dnsConfig/*, sniRegexpMap */)
    }
  }
}

function connect (req, cltSocket, head, hostname, port, dnsConfig/* , sniRegexpMap */) {
  // tunneling https
  // log.info('connect:', hostname, port)
  const start = new Date()
  let isDnsIntercept = null
  const hostport = `${hostname}:${port}`
  // const replaceSni = matchUtil.matchHostname(sniRegexpMap, hostname, 'sni')
  try {
    const options = {
      port,
      host: hostname,
      connectTimeout: 10000
    }
    if (dnsConfig) {
      const dns = DnsUtil.hasDnsLookup(dnsConfig, hostname)
      if (dns) {
        options.lookup = (hostname, options, callback) => {
          const tester = speedTest.getSpeedTester(hostname)
          if (tester) {
            const aliveIpObj = tester.pickFastAliveIpObj()
            if (aliveIpObj) {
              log.info(`----- connect: ${hostport}, use alive ip from dns '${aliveIpObj.dns}': ${aliveIpObj.host} -----`)
              callback(null, aliveIpObj.host, 4)
              return
            }
          }
          dns.lookup(hostname).then(ip => {
            isDnsIntercept = { dns, hostname, ip }
            if (ip !== hostname) {
              log.info(`---- connect: ${hostport}, use ip from dns '${dns.name}': ${ip} ----`)
              callback(null, ip, 4)
            } else {
              log.info(`----- connect: ${hostport}, use hostname: ${hostname} -----`)
              defaultDns.lookup(hostname, options, callback)
            }
          })
        }
      }
    }
    const proxySocket = net.connect(options, () => {
      cltSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                'Proxy-agent: dev-sidecar\r\n' +
                '\r\n')
      log.info('Proxy connect start:', hostport)
      proxySocket.write(head)
      proxySocket.pipe(cltSocket)

      cltSocket.pipe(proxySocket)
    })
    cltSocket.on('timeout', (e) => {
      log.error(`cltSocket timeout: ${hostport}, errorMsg: ${e.message}`)
    })
    cltSocket.on('error', (e) => {
      log.error(`cltSocket error:   ${hostport}, errorMsg: ${e.message}`)
    })
    proxySocket.on('timeout', () => {
      const cost = new Date() - start
      log.info('代理socket timeout：', hostname, port, cost + 'ms')
    })
    proxySocket.on('error', (e) => {
      // 连接失败，可能被GFW拦截，或者服务端拥挤
      const cost = new Date() - start
      log.error('代理连接失败：', e.message, hostname, port, cost + 'ms')
      cltSocket.destroy()
      if (isDnsIntercept) {
        const { dns, ip, hostname } = isDnsIntercept
        dns.count(hostname, ip, true)
        log.error('记录ip失败次数,用于优选ip：', hostname, ip)
      }
    })
    return proxySocket
  } catch (e) {
    log.error(`Proxy connect error: ${hostport}, exception:`, e)
  }
}
