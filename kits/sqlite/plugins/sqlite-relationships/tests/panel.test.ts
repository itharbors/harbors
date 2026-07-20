// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PanelDefinition={mount(context:unknown):Promise<void>;methods:Record<string,(payload:unknown)=>Promise<void>|void>};
const graph={tables:[{name:'users',kind:'table',columns:[{name:'id',type:'INTEGER',primaryKeyOrder:1,foreignKey:false}]}],relationships:[]};

describe('SQLite Relationships panel',()=>{
  beforeEach(()=>{document.body.innerHTML='<div id="panel-root"></div>';vi.resetModules();});

  it('loads the database graph and opens a table in the Schema panel',async()=>{
    const request=vi.fn(async(plugin:string,method:string,input?:unknown)=>{
      if(plugin==='@itharbors/sqlite-core'&&method==='getConnectionState')return{connected:true,path:'/tmp/demo.sqlite',fileName:'demo.sqlite',mode:'readonly',sqliteVersion:'3.46',connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(plugin==='@itharbors/sqlite-core'&&method==='getRelationshipGraph')return graph;
      if(plugin==='@itharbors/sqlite-explorer'&&method==='selectObject')return input;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const openPanel=vi.fn();
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel}});

    expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull();
    (document.querySelector('[data-relationship-table="users"]') as HTMLElement).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    await vi.waitFor(()=>expect(request).toHaveBeenCalledWith('@itharbors/sqlite-explorer','selectObject',{connectionRevision:1,objectName:'users'}));
    expect(openPanel).toHaveBeenCalledWith('@itharbors/sqlite-schema.schema');
  });

  it('restores the historical workspace hierarchy and relationship canvas styling contract',async()=>{
    const visualGraph={
      tables:[
        {name:'users',kind:'table',columns:[{name:'team_id',type:'INTEGER',primaryKeyOrder:0,foreignKey:true}]},
        {name:'teams',kind:'table',columns:[{name:'id',type:'INTEGER',primaryKeyOrder:1,foreignKey:false}]},
      ],
      relationships:[{id:'users-team',fromTable:'users',toTable:'teams',columns:[{from:'team_id',to:'id'}],onUpdate:'NO ACTION',onDelete:'CASCADE'}],
    };
    const request=vi.fn(async(plugin:string,method:string)=>{
      if(plugin==='@itharbors/sqlite-core'&&method==='getConnectionState')return{connected:true,path:'/tmp/demo.sqlite',fileName:'demo.sqlite',mode:'readonly',sqliteVersion:'3.46',connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(plugin==='@itharbors/sqlite-core'&&method==='getRelationshipGraph')return visualGraph;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel:vi.fn()}});

    const workspace=document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > small')?.textContent).toBe('DATABASE');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-title > h1')?.textContent).toBe('demo.sqlite');
    const view=workspace?.querySelector(':scope > .view-host > .relationship-view');
    expect(view?.querySelector(':scope > .relationship-toolbar + .relationship-canvas > .relationship-stage > .relationship-edges')).not.toBeNull();
    expect(view?.querySelector('.relationship-stage > .relationship-table[data-relationship-table="users"]')).not.toBeNull();
    expect(view?.querySelector(':scope > .relationship-details [data-relationship-detail="users-team"]')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-bar[role="status"]')).not.toBeNull();

    const css=readFileSync(resolve(process.cwd(),'plugins/sqlite-relationships/panel.relationships/src/index.css'),'utf8');
    expect(css).toMatch(/--ink:\s*#0b1116/);
    expect(css).toMatch(/--teal:\s*#57c8b5/);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*58px minmax\(0,\s*1fr\) 26px/s);
    expect(css).toMatch(/\.relationship-canvas\s*\{[^}]*overflow:\s*hidden/s);
  });

  it('keeps a warm graph for data changes and reloads it for a newer schema',async()=>{
    const request=vi.fn(async(plugin:string,method:string)=>{
      if(plugin==='@itharbors/sqlite-core'&&method==='getConnectionState')return{connected:true,path:'/tmp/demo.sqlite',mode:'readonly',sqliteVersion:'3.46',connectionRevision:1,schemaRevision:2,dataRevision:3};
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
