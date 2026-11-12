const m=require('@vscode/tree-sitter-wasm');
(async()=>{await m.Parser.init();const l=await m.Language.load(process.argv[2]);const p=new m.Parser();p.setLanguage(l);for(let i=0;i<200;i++){const t=p.parse('class A { func f() {} }');if(i==0)console.log(t.rootNode.toString().slice(0,90));t.delete();}
await new Promise(r=>setTimeout(r,3000));console.log('fine')})()
