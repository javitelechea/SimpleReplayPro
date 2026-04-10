/**
 * Formats XML output for SportCode, NacSport or similar video analysis tools.
 * Following SportCode XML conventions (seconds-based timestamps).
 */
export class ExportManager {
    /**
     * Generates a SportCode-compatible XML string.
     * @param {Object} data - Project data containing clips, tagTypes, clipFlags, etc.
     */
    static generateXML(data) {
        if (!data || !data.clips) return null;

        const clips = data.clips;
        const tagTypes = data.tagTypes || [];
        const clipFlags = data.clipFlags || {};
        const playlistComments = data.playlistComments || {};

        // Start XML without declaration to match SportCode reference
        let xml = `<file>\n`;
        
        // --- ALL_INSTANCES ---
        xml += `  <ALL_INSTANCES>\n`;
        clips.forEach((clip, index) => {
            const tag = tagTypes.find(t => t.id === clip.tag_type_id);
            const category = tag ? tag.label : 'Unknown';

            xml += `    <instance>\n`;
            xml += `      <ID>${index + 1}</ID>\n`;
            xml += `      <start>${clip.start_sec}</start>\n`;
            xml += `      <end>${clip.end_sec}</end>\n`;
            xml += `      <code>${this.escapeXml(category)}</code>\n`;

            // Add Descriptors (Flags)
            const flags = (clipFlags[clip.id] || []).map(f => f.flag);
            if (flags.length > 0) {
                flags.forEach(f => {
                    xml += `      <label>\n        <group>Flags</group>\n        <text>${this.escapeXml(f)}</text>\n      </label>\n`;
                });
            }

            // Add Notes (Comments across all playlists)
            let allComments = [];
            Object.keys(playlistComments).forEach(key => {
                if (key.endsWith('::' + clip.id)) {
                    playlistComments[key].forEach(c => {
                        if (c.text) allComments.push(c.text);
                    });
                }
            });

            if (allComments.length > 0) {
                const notes = allComments.join(" | ");
                xml += `      <label>\n        <group>Notas</group>\n        <text>${this.escapeXml(notes)}</text>\n      </label>\n`;
            }

            xml += `    </instance>\n`;
        });
        xml += `  </ALL_INSTANCES>\n`;

        // --- ROWS ---
        xml += `  <ROWS>\n`;
        const usedTagIds = new Set(clips.map(c => c.tag_type_id));
        const usedTags = tagTypes.filter(t => usedTagIds.has(t.id));

        usedTags.forEach(tag => {
            let r = 65535, g = 65535, b = 65535;
            if (tag.row === 'bottom') {
                r = 65535; g = 20000; b = 20000; // Red-ish
            } else {
                r = 20000; g = 20000; b = 65535; // Blue-ish
            }

            xml += `    <row>\n`;
            xml += `      <code>${this.escapeXml(tag.label)}</code>\n`;
            xml += `      <R>${r}</R>\n`;
            xml += `      <G>${g}</G>\n`;
            xml += `      <B>${b}</B>\n`;
            xml += `    </row>\n`;
        });
        xml += `  </ROWS>\n`;

        xml += `</file>`;

        return xml;
    }

    static escapeXml(unsafe) {
        if (!unsafe) return "";
        return unsafe.toString()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Utility to trigger a file download.
     */
    static download(content, filename, mimeType = 'application/xml') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 100);
    }
}
