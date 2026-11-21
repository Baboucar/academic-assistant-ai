// Minimal Markdown -> HTML for assistant answers, without extra dependencies.
// Everything is HTML-escaped first, so model output can never inject markup.

const escapeHtml = (s) =>
    String(s || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');

function inline(s) {
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>');
    return s;
}

export function mdToHtml(text) {
    const lines = escapeHtml(text).split(/\r?\n/);
    let html = '';
    let list = null; // 'ul' | 'ol' | null

    const closeList = () => {
        if (list) html += `</${list}>`;
        list = null;
    };
    const openList = (tag) => {
        if (list !== tag) {
            closeList();
            html += `<${tag}>`;
            list = tag;
        }
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (!line.trim()) {
            closeList();
            continue;
        }

        const heading = line.match(/^(#{1,3})\s+(.*)$/);
        if (heading) {
            closeList();
            const tag = ['h3', 'h4', 'h5'][heading[1].length - 1];
            html += `<${tag}>${inline(heading[2])}</${tag}>`;
            continue;
        }

        let m;
        if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
            openList('ul');
            html += `<li>${inline(m[1])}</li>`;
            continue;
        }
        if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
            openList('ol');
            html += `<li>${inline(m[1])}</li>`;
            continue;
        }

        closeList();
        html += `<p>${inline(line)}</p>`;
    }
    closeList();
    return html;
}

/** Strip Markdown so text reads naturally when copied or spoken aloud. */
export function mdToPlain(text) {
    return String(text || '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*•]\s+/gm, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/(^|[^*])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1$2')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}
