import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

const REDIS_URL = process.env.REDIS_URL
const BACKEND_URL = process.env.MEDUSA_BACKEND_URL

const WORKER_MODE = (process.env.MEDUSA_WORKER_MODE || "shared").trim().toLowerCase() as
  | "shared"
  | "worker"
  | "server"

// Configure TLS here, never with ?sslmode= in DATABASE_URL: node-postgres treats
// sslmode=require as verify-full and the URL value overrides this setting.
// DATABASE_SSL: "true" (verify), "false" (off), "no-verify" (encrypt only, for
// providers with a private CA when DATABASE_CA_CERT is not set). By default TLS is
// verified for hosts with a dot; Render internal hosts (dpg-xxxx-a) have none and
// stay on the private network without TLS.
function databaseSsl() {
  let mode = process.env.DATABASE_SSL
  if (!mode) {
    try {
      const host = new URL(process.env.DATABASE_URL ?? "").hostname
      mode = host.includes(".") && host !== "127.0.0.1" ? "true" : "false"
    } catch {
      mode = "false"
    }
  }
  if (mode === "false") {
    return false
  }
  if (mode === "no-verify") {
    return { rejectUnauthorized: false }
  }
  return process.env.DATABASE_CA_CERT
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT }
    : { rejectUnauthorized: true }
}

const fileModule = process.env.S3_BUCKET
  ? {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-s3",
            id: "s3",
            options: {
              file_url: process.env.S3_FILE_URL,
              access_key_id: process.env.S3_ACCESS_KEY_ID,
              secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
              region: process.env.S3_REGION,
              bucket: process.env.S3_BUCKET,
              endpoint: process.env.S3_ENDPOINT,
              additional_client_config: {
                forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
              },
            },
          },
        ],
      },
    }
  : {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/file-local",
            id: "local",
            options: {
              backend_url: `${BACKEND_URL || "http://localhost:9000"}/static`,
            },
          },
        ],
      },
    }

// Without REDIS_URL (local dev) Medusa falls back to its in-memory modules.
const redisModules = REDIS_URL
  ? [
      // Deprecated in favor of the Caching Module, but the Auth Module still
      // stores OAuth state and MFA challenges in it.
      {
        resolve: "@medusajs/medusa/cache-redis",
        options: { redisUrl: REDIS_URL },
      },
      {
        resolve: "@medusajs/medusa/event-bus-redis",
        options: {
          redisUrl: REDIS_URL,
          jobOptions: { removeOnFail: { age: 3600, count: 1000 } },
          workerOptions: { drainDelay: 60 },
        },
      },
      {
        resolve: "@medusajs/medusa/workflow-engine-redis",
        options: { redis: { redisUrl: REDIS_URL } },
      },
      {
        resolve: "@medusajs/medusa/locking",
        options: {
          providers: [
            {
              resolve: "@medusajs/medusa/locking-redis",
              id: "locking-redis",
              is_default: true,
              options: { redisUrl: REDIS_URL },
            },
          ],
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    databaseDriverOptions: {
      connection: {
        ssl: databaseSsl(),
      },
    },
    redisUrl: REDIS_URL,
    workerMode: WORKER_MODE,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    disable: process.env.DISABLE_MEDUSA_ADMIN === "true",
    backendUrl: BACKEND_URL || "/",
  },
  modules: [fileModule, ...redisModules],
})
