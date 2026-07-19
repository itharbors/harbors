import { MysqlService } from './mysql-service.js';

declare const editor: any;

const service = new MysqlService();

editor.plugin.define({
  lifecycle: {
    async unload() {
      await service.dispose();
    },
  },
  methods: {
    getConnectionState: () => service.getConnectionState(),
    connect: (input: unknown) => service.connect(input),
    disconnect: () => service.disconnect(),
    getSchema: () => service.getSchema(),
    getObjectSchema: (input: unknown) => service.getObjectSchema(input),
    getRows: (input: unknown) => service.getRows(input),
    insertRow: (input: unknown) => service.insertRow(input),
    updateRow: (input: unknown) => service.updateRow(input),
    deleteRow: (input: unknown) => service.deleteRow(input),
    executeSql: (input: unknown) => service.executeSql(input),
  },
});
