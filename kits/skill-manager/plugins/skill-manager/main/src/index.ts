declare const editor: any;

const EMPTY_SNAPSHOT = Object.freeze({
  revision: 0,
  generation: 0,
  source: null,
  skills: Object.freeze([]),
});

editor.plugin.define({
  methods: {
    getSnapshot() {
      return EMPTY_SNAPSHOT;
    },
    browseDirectory() {
      return Object.freeze({ revision: 0, directory: null, entries: Object.freeze([]) });
    },
    selectSource() {
      return EMPTY_SNAPSHOT;
    },
    clearSource() {
      return EMPTY_SNAPSHOT;
    },
    rescan() {
      return EMPTY_SNAPSHOT;
    },
    getSkillDetail() {
      return null;
    },
    performAction() {
      return EMPTY_SNAPSHOT;
    },
  },
});
