export class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

/** Let async route handlers throw; the error lands in errorMiddleware. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorMiddleware(err, req, res, _next) {
    // multer and body-parser errors carry their own status/code
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Server error';
    if (err.code === 'LIMIT_FILE_SIZE') {
        status = 413;
        message = 'File is too large';
    }

    if (status >= 500 && !(err instanceof HttpError)) {
        // Unexpected failure: log it, and do not leak internals to the client
        console.error(err);
        message = 'Server error';
    }

    if (res.headersSent) return res.end();
    const body = { error: message };
    if (err.details) body.details = err.details;
    res.status(status).json(body);
}
