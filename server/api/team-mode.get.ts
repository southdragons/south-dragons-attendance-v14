export default defineEventHandler((event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const config = useRuntimeConfig(event)
  // Partial configuration must fail closed rather than reverting to demo data.
  return { mode: config.gasWebAppUrl || config.gasApiKey ? 'gas' : 'demo' }
})
