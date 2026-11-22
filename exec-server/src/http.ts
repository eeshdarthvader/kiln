import type { ErrorRequestHandler } from 'express';
import { FactoryError } from './domain.ts';

export function errorEnvelope(error: unknown, message = 'Unable to process this request.') {
  if (error instanceof FactoryError)
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  return { error: { code: 'INTERNAL_ERROR', message } };
}

export const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof FactoryError) {
    res.status(error.status).json(errorEnvelope(error));
    return;
  }
  const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : '';
  if (type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the 1 MB limit.' },
    });
    return;
  }
  if (type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'VALIDATION_FAILED', message: 'Invalid JSON request body.' },
    });
    return;
  }
  res.status(500).json(errorEnvelope(error));
};
