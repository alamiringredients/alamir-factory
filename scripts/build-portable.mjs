import {build} from 'vite';
import path from 'node:path';
await build({configFile:false,root:path.resolve('portable'),esbuild:{jsx:'automatic'},build:{outDir:path.resolve('standalone/public'),emptyOutDir:true}});
await build({configFile:false,build:{ssr:path.resolve('lib/workflow.ts'),outDir:path.resolve('standalone'),emptyOutDir:false,rollupOptions:{output:{entryFileNames:'workflow.mjs'}}}});
