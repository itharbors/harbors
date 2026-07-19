import { SqliteService } from './sqlite-service.js';

declare const editor: any;

const service = new SqliteService();

editor.plugin.define({
  lifecycle: {
    unload() {
      service.dispose();
    },
  },
  methods: {
    getConnectionState: () => service.getConnectionState(),
    openDatabase: (input: unknown) => service.openDatabase(input),
    closeDatabase: () => service.closeDatabase(),
    getSchema: () => service.getSchema(),
    getObjectSchema: (input: unknown) => service.getObjectSchema(input),
    getRows: (input: unknown) => service.getRows(input),
    insertRow: (input: unknown) => service.insertRow(input),
    updateRow: (input: unknown) => service.updateRow(input),
    deleteRow: (input: unknown) => service.deleteRow(input),
    executeSql: (input: unknown) => service.executeSql(input),
  },
});
