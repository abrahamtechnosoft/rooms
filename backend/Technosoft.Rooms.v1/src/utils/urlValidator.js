function validateUrl(value, fieldName = 'enlace') {
  if (value == null) {
    return { valid: true, error: null };
  }
  if (typeof value !== 'string') {
    return { valid: false, error: `El ${fieldName} es inválido` };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { valid: true, error: null };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      valid: false,
      error: `El ${fieldName} debe comenzar con http:// o https://`,
    };
  }

  try {
    const url = new URL(trimmed);
    if (!url.hostname || url.hostname.length === 0) {
      return { valid: false, error: `El ${fieldName} es inválido` };
    }
    if (!url.hostname.includes('.')) {
      return {
        valid: false,
        error: `El ${fieldName} debe tener un dominio válido`,
      };
    }
    return { valid: true, error: null };
  } catch {
    return { valid: false, error: `El ${fieldName} es inválido` };
  }
}

module.exports = { validateUrl };
