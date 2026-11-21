// Re-export so server/index.js (not yet converted) keeps importing ./routes/health.js; remove with the boot-path conversion.
export { default } from './health.ts'
export { HEALTH_DB_TIMEOUT_MS,dbPing,createHealthHandler } from './health.ts'
