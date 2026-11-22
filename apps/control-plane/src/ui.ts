import express, { type Express } from 'express';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultUiDirectory = fileURLToPath(new URL('../dist/', import.meta.url));

export function mountUi(app: Express, uiDirectory = defaultUiDirectory): void {
  app.get('/', (_req, res, next) => {
    res.sendFile(join(uiDirectory, 'index.html'), (error) => {
      if (!error) return;
      if (res.headersSent) {
        next(error);
        return;
      }

      const fileError = error as NodeJS.ErrnoException & { status?: number };
      if (fileError.status === 404 || fileError.code === 'ENOENT' || fileError.code === 'ENOTDIR') {
        res.status(503).json({
          error: {
            code: 'UI_NOT_BUILT',
            message: 'The dashboard is not built. Run npm run build.',
          },
        });
        return;
      }
      next(error);
    });
  });

  app.use(
    '/assets',
    express.static(join(uiDirectory, 'assets'), {
      dotfiles: 'deny',
      fallthrough: true,
      index: false,
      redirect: false,
    }),
  );
}
