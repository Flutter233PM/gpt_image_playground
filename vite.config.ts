import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { normalizeDevProxyConfig } from './src/lib/devProxy'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

function loadDevProxyConfig() {
  try {
    return normalizeDevProxyConfig(
      JSON.parse(readFileSync('./dev-proxy.config.json', 'utf-8')) as unknown,
    )
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'ENOENT') return null
    throw error
  }
}

function extractSub2ApiWebSocketApiKey(header: unknown): string {
  const raw = Array.isArray(header)
    ? header.join(',')
    : typeof header === 'string'
      ? header
      : ''
  const match = raw.match(/(?:^|,)\s*sub2api-api-key\.([^,\s]+)/i)
  return match?.[1]?.trim() ?? ''
}

export default defineConfig(({ command }) => {
  const devProxyConfig = command === 'serve' ? loadDevProxyConfig() : null

  return {
    plugins: [react()],
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __DEV_PROXY_CONFIG__: JSON.stringify(devProxyConfig),
    },
    server: {
      host: true,
      proxy:
        devProxyConfig?.enabled
          ? {
              [devProxyConfig.prefix]: {
                target: devProxyConfig.target,
                changeOrigin: devProxyConfig.changeOrigin,
                secure: devProxyConfig.secure,
                ws: true,
                configure: (proxy) => {
                  proxy.on('proxyReqWs', (proxyReq, req) => {
                    const apiKey = extractSub2ApiWebSocketApiKey(req.headers['sec-websocket-protocol'])
                    if (apiKey) {
                      proxyReq.setHeader('Authorization', `Bearer ${apiKey}`)
                    }
                  })
                },
                rewrite: (path) =>
                  path.replace(
                    new RegExp(`^${devProxyConfig.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
                    '',
                  ),
              },
            }
          : undefined,
    },
  }
})
