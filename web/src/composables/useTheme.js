// Light / dark / system theme. shadcn styles key off a `dark` class on <html>.
// index.html applies the saved theme before the app mounts to avoid a flash.
import { useColorMode } from '@vueuse/core';

export const THEME_STORAGE_KEY = 'utg-theme';

export function useTheme() {
    // `store` is the user's choice ('light' | 'dark' | 'auto'); `mode` is what is showing.
    const mode = useColorMode({
        storageKey: THEME_STORAGE_KEY,
        attribute: 'class',
        disableTransition: true,
    });
    return { mode, choice: mode.store };
}
