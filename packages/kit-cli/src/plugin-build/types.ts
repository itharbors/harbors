export interface PluginMain {
  sourceDir: string;
  distDir: string;
  entryFile: string;
  outputFile: string;
}

export interface PluginPanel {
  name: string;
  entry: string;
  sourceDir: string;
  distDir: string;
  scriptEntryFile: string;
  htmlSourceFile: string;
  cssSourceFile: string;
  htmlOutputFile: string;
  jsOutputFile: string;
  cssOutputFile: string;
}

export interface PluginProject {
  rootDir: string;
  packageJsonPath: string;
  tsconfigPath: string;
  pkg: Record<string, unknown>;
  main: PluginMain | null;
  panels: PluginPanel[];
}
