const { err } = require("../utils/reply");

const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) {
    return res.status(403).json(err("Sin permisos"));
  }
  return next();
};

module.exports = { requireRole };
