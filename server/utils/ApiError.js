export class ApiError extends Error {
  /** @param {string} [code] machine-readable reason the client can act on (e.g. PASSWORD_CHANGE_REQUIRED) */
  constructor(status, message, details, code) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}
