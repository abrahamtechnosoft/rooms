const jwt = require("jsonwebtoken");
const { err } = require("../utils/reply");

const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return res.status(401).json(err("Sesion no valida"));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      userId: decoded.userId,
      role: decoded.role,
      fullName: decoded.fullName,
    };
    return next();
  } catch (_) {
    return res.status(401).json(err("Sesion no valida"));
  }
};

module.exports = authMiddleware;
