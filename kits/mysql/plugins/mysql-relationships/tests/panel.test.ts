// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('restores the historical workspace hierarchy and MySQL relationship canvas styling contract',async()=>{
    const visualGraph={
      tables:[
        {name:'users',kind:'table',columns:[{name:'team_id',type:'BIGINT',primaryKeyOrder:0,foreignKey:true}]},
        {name:'teams',kind:'table',columns:[{name:'id',type:'BIGINT',primaryKeyOrder:1,foreignKey:false}]},
      ],
      relationships:[{id:'users-team',fromTable:'users',toTable:'teams',columns:[{from:'team_id',to:'id'}],onUpdate:'CASCADE',onDelete:'RESTRICT'}],
    };
    const request=vi.fn(async(plugin:string,method:string)=>{
      if(plugin==='@itharbors/mysql-core'&&method==='getConnectionState')return{connected:true,endpoint:'db.local:3306',database:'app',mysqlVersion:'8.4.1',tls:false,connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(plugin==='@itharbors/mysql-core'&&method==='getRelationshipGraph')return visualGraph;
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel:vi.fn()}});

    const workspace=document.querySelector<HTMLElement>('#panel-root > .workspace');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > .object-kind')?.textContent).toBe('数据库');
    expect(workspace?.querySelector(':scope > .workspace-heading .object-identity > h1.object-title')?.textContent).toBe('app');
    const view=workspace?.querySelector<HTMLElement>(':scope > .view-host > .relationship-view');
    expect(view?.getAttribute('aria-label')).toBe('MySQL 表关系图');
    expect(view?.hasAttribute('aria-labelledby')).toBe(false);
    expect(view?.querySelector(':scope > .relationship-toolbar + .relationship-canvas > .relationship-stage > .relationship-edges')).not.toBeNull();
    expect(view?.querySelector('.relationship-stage > .relationship-table[data-relationship-table="users"]')).not.toBeNull();
    const details=view?.querySelector<HTMLElement>(':scope > aside.relationship-details');
    expect(details?.getAttribute('role')).toBe('region');
    expect(details?.getAttribute('aria-label')).toBe('关系映射明细');
    expect(details?.hasAttribute('aria-modal')).toBe(false);
    expect(details?.querySelector('[data-relationship-detail="users-team"]')).not.toBeNull();
    expect(workspace?.querySelector(':scope > .status-deck > [role="status"] + .error-slot')).not.toBeNull();

    const css=readFileSync(resolve(process.cwd(),'plugins/mysql-relationships/panel.relationships/src/index.css'),'utf8');
    expect(css).toMatch(/--ink:\s*#07111d/);
    expect(css).toMatch(/--blue:\s*#4d9bd3/);
    expect(css).toMatch(/--cyan:\s*#76d0ec/);
    expect(css).toMatch(/--amber:\s*#f0ba57/);
    expect(css).toMatch(/h1\.object-title\s*\{[^}]*margin:\s*0/s);
    expect(css).toMatch(/\.workspace\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.relationship-view\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(css).toMatch(/\.relationship-toolbar\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.relationship-canvas\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.relationship-details\s*\{[^}]*overflow:\s*auto/s);
  });

  it('clears an error into a single visible retry request',async()=>{
    let resolveRetry:((value:unknown)=>void)|undefined;
    const pendingRetry=new Promise<unknown>((resolve)=>{resolveRetry=resolve;});
    let graphRequests=0;
    const request=vi.fn(async(plugin:string,method:string)=>{
      if(plugin==='@itharbors/mysql-core'&&method==='getConnectionState')return{connected:true,endpoint:'db.local:3306',database:'app',mysqlVersion:'8.4.1',tls:false,connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(plugin==='@itharbors/mysql-core'&&method==='getRelationshipGraph'){
        graphRequests+=1;
        if(graphRequests===1)throw new Error('关系图读取失败');
        return pendingRetry;
      }
      throw new Error(`Unexpected ${plugin}:${method}`);
    });
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel:vi.fn()}});
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('关系图读取失败');

    (document.querySelector('[data-action="retry"]') as HTMLButtonElement).click();

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('.view-host')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('正在读取关系图…');
    expect(document.querySelector('.activity-spinner')).not.toBeNull();
    document.querySelector<HTMLButtonElement>('[data-action="retry"]')?.click();
    expect(graphRequests).toBe(2);

    resolveRetry?.(graph);
    await vi.waitFor(()=>expect(document.querySelector('[data-relationship-table="users"]')).not.toBeNull());
  });

  it('shows table opening progress and blocks duplicate table requests',async()=>{
    let resolveSelection:((value:unknown)=>void)|undefined;
    const pendingSelection=new Promise<unknown>((resolve)=>{resolveSelection=resolve;});
    const request=vi.fn(async(plugin:string,method:string,input?:unknown)=>{
      if(plugin==='@itharbors/mysql-core'&&method==='getConnectionState')return{connected:true,endpoint:'db.local:3306',database:'app',mysqlVersion:'8.4.1',tls:false,connectionRevision:1,schemaRevision:2,dataRevision:3};
      if(plugin==='@itharbors/mysql-core'&&method==='getRelationshipGraph')return graph;
      if(plugin==='@itharbors/mysql-explorer'&&method==='selectObject')return pendingSelection;
      throw new Error(`Unexpected ${plugin}:${method}:${String(input)}`);
    });
    const openPanel=vi.fn();
    const definition=(await import('../panel.relationships/src/index')).default as PanelDefinition;
    await definition.mount({message:{request},panel:{openPanel}});
    const table=document.querySelector('[data-relationship-table="users"]') as HTMLElement;

    table.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));

    expect(document.querySelector('.view-host')?.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('正在打开 users…');
    (document.querySelector('[data-relationship-table="users"]') as HTMLElement)
      .dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    expect(request.mock.calls.filter((call)=>call[1]==='selectObject')).toHaveLength(1);

    resolveSelection?.({connectionRevision:1,objectName:'users'});
    await vi.waitFor(()=>expect(openPanel).toHaveBeenCalledWith('@itharbors/mysql-schema.schema'));
  });
});
