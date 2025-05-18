import * as editor from './export/editor';
declare global {
    export import Editor = editor;
}

export default editor;

declare global {
    interface EditorContributeData {
        message?: {
            [key in string]: {
                method: string[];
            };
        };
    }
}

declare global {
    interface EditorContributeData {
        panel?: {
            [key in string]: string;
        };
    }
}
