// server/src/index.js
import { env } from './env.js';
import { createApp } from './app.js';

if (!env.GROQ_API_KEY) {
    console.warn('GROQ_API_KEY is not set: chat requests will fail until it is added to server/.env');
}
if (!env.ADMIN_USER || !env.ADMIN_PASS) {
    console.warn('ADMIN_USER / ADMIN_PASS are not set: the admin dashboard is disabled');
}

if (env.DEV_SHOW_CODES) {
    console.warn(
        env.SMTP_HOST
            ? 'DEV_SHOW_CODES is ignored because SMTP_HOST is set.'
            : 'DEV_SHOW_CODES is on: sign-up codes are shown on screen instead of emailed. Local testing only.',
    );
} else if (!env.SMTP_HOST) {
    console.warn('SMTP_HOST is not set: sign-up codes are printed in this log instead of emailed');
}

createApp().listen(env.PORT, () => {
    console.log(`API on :${env.PORT}`);
});
