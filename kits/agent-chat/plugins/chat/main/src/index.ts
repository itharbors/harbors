import { normalizeLink } from './normalize-link.js';

declare const editor: any;

editor.plugin.define({
  lifecycle: {
    load() {},
    unload() {},
  },
  methods: {
    normalizeLink(originalHref: string, selectedProject?: string | null) {
      return normalizeLink(originalHref, selectedProject);
    },
  },
});
