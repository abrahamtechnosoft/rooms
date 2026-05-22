const router = require('express').Router();
const { getPool } = require('../config/db');
const { ok, err } = require('../utils/reply');

router.get('/', async (req, res) => {
  try {
    const pool   = await getPool();
    const result = await pool.request().query('SELECT 1 AS up');
    return res.json(ok({ db: result.recordset[0].up === 1 }, 'Servicio operativo'));
  } catch (e) {
    return res.status(503).json(err('Base de datos no disponible'));
  }
});

module.exports = router;
