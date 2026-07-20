import { MYSQL_CORE, MYSQL_EXPLORER, unwrapMysqlResponse, type ConnectionSnapshot, type SelectionSnapshot } from '@itharbors/mysql-contracts';

type Context = { message: { request(plugin: string, method: string, input?: unknown): Promise<unknown> } };
type Column = { name: string; type: string; nullable: boolean; defaultValue: string | null; extra: string; generated: boolean };
type Index = { name: string; unique: boolean; primary: boolean; type: string; columns: string[] };
type ForeignKey = { name: string; column: string; referencedTable: string; referencedColumn: string; onUpdate: string; onDelete: string };
type ObjectSchema = { name: string; type: 'table' | 'view'; columns: Column[]; primaryKey: string[]; indexes: Index[]; foreignKeys: ForeignKey[]; sql: string };
const DISCONNECTED: ConnectionSnapshot = { connected:false,endpoint:null,database:null,mysqlVersion:null,tls:false,connectionRevision:0,schemaRevision:0,dataRevision:0 };
let context:Context|undefined;let root:HTMLElement|null=null;let connection:ConnectionSnapshot={...DISCONNECTED};let selection:SelectionSnapshot={connectionRevision:0,objectName:null};let schema:ObjectSchema|null=null;let error:string|null=null;let sequence=0;
const definition={async mount(ctx:Context){context=ctx;root=document.querySelector('#panel-root');if(!root)throw new Error('Panel root element #panel-root not found');reset();render();const current=++sequence;try{const[nextConnection,nextSelection]=await Promise.all([core<ConnectionSnapshot>('getConnectionState'),explorer<SelectionSnapshot>('getSelection')]);if(current!==sequence)return;connection=nextConnection;selection=nextSelection.connectionRevision===nextConnection.connectionRevision?nextSelection:{connectionRevision:nextConnection.connectionRevision,objectName:null};await load();}catch(caught){if(current===sequence)setError(caught);}},unmount(){sequence++;root?.replaceChildren();root=null;context=undefined;reset();},methods:{async onConnectionChanged(payload:unknown){if(!isConnection(payload))return;connection=payload;selection={connectionRevision:payload.connectionRevision,objectName:null};schema=null;error=null;sequence++;render();},async onSelectionChanged(payload:unknown){if(!isSelection(payload)||payload.connectionRevision!==connection.connectionRevision)return;selection=payload;schema=null;await load();},async onSchemaChanged(payload:unknown){if(!isRevision(payload)||payload.connectionRevision!==connection.connectionRevision)return;connection={...connection,schemaRevision:payload.schemaRevision,dataRevision:payload.dataRevision};await load();}}};export default definition;
function reset(){connection={...DISCONNECTED};selection={connectionRevision:0,objectName:null};schema=null;error=null;sequence++;}
async function load(){if(!connection.connected||!selection.objectName){schema=null;render();return;}const current=++sequence;const name=selection.objectName;try{const next=await core<ObjectSchema>('getObjectSchema',{name});if(current!==sequence||name!==selection.objectName)return;schema=next;error=null;}catch(caught){if(current!==sequence)return;setError(caught,false);}render();}
async function core<T>(method:string,input?:unknown):Promise<T>{if(!context)throw new Error('MySQL 结构面板尚未挂载');return unwrapMysqlResponse<T>(await context.message.request(MYSQL_CORE,method,input));}
async function explorer<T>(method:string):Promise<T>{if(!context)throw new Error('MySQL 结构面板尚未挂载');return context.message.request(MYSQL_EXPLORER,method) as Promise<T>;}
function render(){
  if(!root)return;
  root.replaceChildren();
  const workspace=document.createElement('main');
  workspace.className='workspace';
  const header=document.createElement('header');
  header.className='workspace-heading';
  const identity=document.createElement('div');
  identity.className='object-identity';
  append(identity,'span',schema?.type==='view'?'视图':selection.objectName?'表':'数据库').className='object-kind';
  append(identity,'strong',selection.objectName??'未选择对象').className='object-title';
  header.append(identity);
  const host=document.createElement('section');
  host.className='view-host';
  const footer=document.createElement('footer');
  footer.className='status-deck';
  const status=append(footer,'div',schema?`已加载 ${schema.name} 结构`:connection.connected&&selection.objectName?'正在读取结构…':'等待选择数据库对象');
  status.setAttribute('role','status');
  status.setAttribute('aria-live','polite');
  const errorSlot=document.createElement('div');
  errorSlot.className='error-slot';
  footer.append(errorSlot);
  workspace.append(header,host,footer);
  root.append(workspace);

  if(error){
    const alert=append(errorSlot,'div',error);
    alert.setAttribute('role','alert');
    append(host,'p','无法读取结构。').className='empty';
    return;
  }
  if(!connection.connected){append(host,'p','请先连接 MySQL 数据库。').className='empty';return;}
  if(!selection.objectName){append(host,'p','请在资源管理器中选择表或视图。').className='empty';return;}
  if(!schema){append(host,'p','正在读取结构…').className='empty';return;}

  const view=document.createElement('div');
  view.className='schema-view';
  view.dataset.view='schema';
  const columns=card('字段','schema-columns');
  const table=document.createElement('table');
  const thead=document.createElement('thead');
  const head=document.createElement('tr');
  for(const label of['名称','类型','可空','默认值','附加信息'])append(head,'th',label);
  thead.append(head);
  const tbody=document.createElement('tbody');
  for(const column of schema.columns){
    const row=document.createElement('tr');
    append(row,'td',column.name);
    append(row,'td',column.type);
    append(row,'td',column.nullable?'是':'否');
    append(row,'td',column.defaultValue??'—');
    append(row,'td',column.extra||(column.generated?'生成字段':'—'));
    tbody.append(row);
  }
  table.append(thead,tbody);
  columns.append(table);

  const indexes=card('索引','schema-indexes');
  if(schema.indexes.length===0)append(indexes,'p','没有索引。');
  for(const index of schema.indexes){
    const item=document.createElement('div');
    item.className='schema-item';
    append(item,'strong',index.name);
    append(item,'span',`${index.unique?'UNIQUE':'INDEX'} · ${index.type} · ${index.columns.join(', ')}`);
    indexes.append(item);
  }

  const foreign=card('外键','schema-foreign-keys');
  if(schema.foreignKeys.length===0)append(foreign,'p','没有外键。');
  for(const key of schema.foreignKeys){
    const item=document.createElement('div');
    item.className='schema-item';
    append(item,'strong',key.name);
    append(item,'span',`${key.column} → ${key.referencedTable}.${key.referencedColumn}`);
    append(item,'small',`ON UPDATE ${key.onUpdate} · ON DELETE ${key.onDelete}`);
    foreign.append(item);
  }

  const ddl=card('定义 SQL','schema-definition');
  append(ddl,'pre',schema.sql);
  view.append(columns,indexes,foreign,ddl);
  host.append(view);
}
function card(title:string,className:string){const value=document.createElement('section');value.className=`schema-card ${className}`;append(value,'h2',title);return value;}function append<K extends keyof HTMLElementTagNameMap>(parent:Element,tag:K,text:string){const value=document.createElement(tag);value.textContent=text;parent.append(value);return value;}function setError(caught:unknown,rerender=true){error=caught instanceof Error?caught.message:String(caught);if(rerender)render();}function isRevision(value:unknown):value is {connectionRevision:number;schemaRevision:number;dataRevision:number}{return typeof value==='object'&&value!==null&&Number.isInteger((value as any).connectionRevision)&&Number.isInteger((value as any).schemaRevision)&&Number.isInteger((value as any).dataRevision)}function isConnection(value:unknown):value is ConnectionSnapshot{return isRevision(value)&&typeof(value as any).connected==='boolean'}function isSelection(value:unknown):value is SelectionSnapshot{return typeof value==='object'&&value!==null&&Number.isInteger((value as any).connectionRevision)&&((value as any).objectName===null||typeof(value as any).objectName==='string')}
