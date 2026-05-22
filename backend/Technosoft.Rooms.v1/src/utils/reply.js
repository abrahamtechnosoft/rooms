const ok = (obj, msg = "OK") => ({ ok: true, obj, msg });
const err = (msg = "Operacion fallida", obj = null) => ({ ok: false, obj, msg });

module.exports = { ok, err };
