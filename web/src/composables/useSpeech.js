// Voice: dictating a question (speech recognition) and reading answers aloud
// (speech synthesis). Both use the browser's built-in Web Speech API, so there
// is no extra service or key. Recognition is missing in some browsers (Firefox);
// callers check `supported` and hide the control.
import { onBeforeUnmount, ref } from 'vue';
import { mdToPlain } from '@/lib/markdown';

function speechLang() {
    const lang = typeof navigator !== 'undefined' ? navigator.language : '';
    return lang && lang.toLowerCase().startsWith('en') ? lang : 'en-GB';
}

const RECOGNITION_ERRORS = {
    'not-allowed': 'Microphone access is blocked. Allow it in your browser settings to use voice.',
    'service-not-allowed': 'Microphone access is blocked. Allow it in your browser settings to use voice.',
    'audio-capture': 'No microphone was found.',
    network: 'Voice input needs an internet connection in this browser.',
    'language-not-supported': 'Voice input does not support this language.',
};

/**
 * Dictation. `onResult(text)` fires as words arrive; `onFinal(text)` fires once
 * when the speaker stops on their own. Calling stop() ends listening without
 * firing onFinal, so the text can be edited before sending.
 */
export function useSpeechRecognition({ onResult, onFinal, onError } = {}) {
    const Recognition =
        typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
    const supported = Boolean(Recognition);
    const listening = ref(false);

    let recognition = null;
    let transcript = '';
    let cancelled = false;

    function start() {
        if (!supported || listening.value) return;
        transcript = '';
        cancelled = false;

        recognition = new Recognition();
        recognition.lang = speechLang();
        recognition.interimResults = true;
        recognition.continuous = false;
        recognition.maxAlternatives = 1;

        recognition.onresult = (event) => {
            let text = '';
            for (let i = 0; i < event.results.length; i++) text += event.results[i][0].transcript;
            transcript = text.trim();
            onResult?.(transcript);
        };
        recognition.onerror = (event) => {
            // "no-speech" and "aborted" are just the user not talking or cancelling
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            cancelled = true;
            onError?.(RECOGNITION_ERRORS[event.error] || 'Voice input stopped unexpectedly. Please try again.');
        };
        recognition.onend = () => {
            listening.value = false;
            recognition = null;
            if (!cancelled && transcript) onFinal?.(transcript);
        };

        try {
            recognition.start();
            listening.value = true;
        } catch {
            listening.value = false;
            onError?.('Voice input could not start. Please try again.');
        }
    }

    function stop() {
        cancelled = true;
        try {
            recognition?.stop();
        } catch {
            // already stopped
        }
        listening.value = false;
    }

    onBeforeUnmount(stop);

    return { supported, listening, start, stop };
}

// ---- Read aloud (shared, so only one answer speaks at a time) ----
const speakingId = ref(null);

const synth = () => (typeof window !== 'undefined' ? window.speechSynthesis : null);

export function useSpeechSynthesis() {
    const supported = Boolean(synth()) && typeof window.SpeechSynthesisUtterance !== 'undefined';

    function stop() {
        synth()?.cancel();
        speakingId.value = null;
    }

    function speak(id, text) {
        if (!supported) return;
        const plain = mdToPlain(text);
        if (!plain) return;
        synth().cancel();

        const utterance = new window.SpeechSynthesisUtterance(plain);
        utterance.lang = speechLang();
        const done = () => {
            if (speakingId.value === id) speakingId.value = null;
        };
        utterance.onend = done;
        utterance.onerror = done;

        speakingId.value = id;
        synth().speak(utterance);
    }

    /** Start reading a message, or stop if it is the one being read. */
    function toggle(id, text) {
        if (speakingId.value === id) stop();
        else speak(id, text);
    }

    return { supported, speakingId, speak, stop, toggle };
}
