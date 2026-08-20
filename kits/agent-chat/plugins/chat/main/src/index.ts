import { normalizeLink } from './normalize-link.js';

declare const editor: any;

interface MarkdownRendererContribution {
  languages: string[];
  entry: string;
}

interface RegisteredRenderer {
  plugin: string;
  languages: string[];
  entry: string;
}

const renderers = new Map<string, RegisteredRenderer>();

editor.plugin.define({
  lifecycle: {
    load() {},
    unload() {},
    attach(pluginName: string, contribute: any) {
      const chatContribution = contribute?.chat;
      const renderer = chatContribution?.markdownRenderer as MarkdownRendererContribution | undefined;
      if (renderer?.languages?.length && renderer.entry) {
        renderers.set(pluginName, {
          plugin: pluginName,
          languages: renderer.languages,
          entry: renderer.entry,
        });
      }
    },
    detach(pluginName: string) {
      renderers.delete(pluginName);
    },
  },
  methods: {
    normalizeLink(originalHref: string, selectedProject?: string | null) {
      return normalizeLink(originalHref, selectedProject);
    },
    getMarkdownRenderers(): RegisteredRenderer[] {
      return Array.from(renderers.values());
    },
  },
});
