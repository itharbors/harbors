// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

type PanelDefinition={mount(context:unknown):Promise<void>;methods:Record<string,(payload:unknown)=>Promise<void>|void>};
const graph={tables:[{name:'users',kind:'table',columns:[{name:'id',type:'INTEGER',primaryKeyOrder:1,foreignKey:false}]}],relationships:[]};

describe('MySQL Relationships panel',()=>{
  beforeEach(()=>{document.body.innerHTML='<div id="panel-root"></div>';vi.resetModules();});

  it('loads the database graph and opens a table in the Schema panel',async()=>{
    const request=vi.fn(async(plugin:string,method:string,input?:unknown)=>{
      if(plugin==='@itharbors/mysql-core'&&method==='getConnectionState')return{connected:true,endpoint:'db.local:3306',database:'app',mysqlVersion:'8.4.1',tls:false,connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(plugin==='@itharbors/mysql-core'&&method==='getRelationshipGraph')return graph;
      if(plugin==='@itharbors/mysql-explorer'&&method==='selectObject')return input;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const openPanel=vi.fn();
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel}});

    expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull();
    (document.querySelector('[data-relationship-table="users"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await vi.waitFor(()=>expect(request).toHaveBeenCalledWith('@itharbors/mysql-explorer','selectObject',{connectionRevision:1,objectName:'users'}));
    expect(openPanel).toHaveBeenCalledWith('@itharbors/mysql-schema.schema');
  });

  it('keeps a warm graph for data changes and reloads it for a newer schema',async()=>{
    const request=vi.fn(async(plugin:string,method:string)=>{
      if(plugin==='@itharbors/mysql-core'&&method==='getConnectionState')return{connected:true,endpoint:'db.local:3306',database:'app',mysqlVersion:'8.4.1',tls:false,connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(method==='getRelationshipGraph')return graph;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel:vi.fn()}});
    const before=request.mock.calls.filter(call=>call[1]==='getRelationshipGraph').length;

    await definition.methods.onDataChanged({connectionRevision:1,schemaRevision:2,dataRevision:4,objectName:'users'});
    expect(request.mock.calls.filter(call=>call[1]==='getRelationshipGraph')).toHaveLength(before);
    await definition.methods.onSchemaChanged({connectionRevision:1,schemaRevision:3,dataRevision:4});
    expect(request.mock.calls.filter(call=>call[1]==='getRelationshipGraph')).toHaveLength(before+1);
  });
});
