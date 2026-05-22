const sql = require('mssql');

let poolPromise = null;

function buildConfig() {
  const useInstance = !!process.env.DB_INSTANCE;

  const cfg = {
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server:   process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    options: {
      encrypt:                process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
      enableArithAbort:       true
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout:    15000
  };

  if (useInstance) {
    cfg.options.instanceName = process.env.DB_INSTANCE;
  } else {
    cfg.port = parseInt(process.env.DB_PORT || '1433', 10);
  }

  return cfg;
}

async function getPool() {
  if (poolPromise) return poolPromise;

  poolPromise = sql.connect(buildConfig())
    .then(pool => {
      console.log('[DB] Conectado a SQL Server');
      return pool;
    })
    .catch(err => {
      console.warn('[DB] No fue posible conectar:', err.message);
      poolPromise = null;
      throw err;
    });

  return poolPromise;
}

module.exports = { getPool, sql };
