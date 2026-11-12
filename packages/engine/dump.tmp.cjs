const m=require('@vscode/tree-sitter-wasm');const W=require('path').dirname(require.resolve('tree-sitter-wasms/package.json'))+'/out/';
const S={
 c_sharp:'namespace N {\npublic class Shop {\n  public void Open(int n) {\n  }\n}\ninterface IShop {}\nenum E { A }\nstruct P {}\n}\n',
 kotlin:'class Shop {\n  fun open(n: Int): Int {\n    return n\n  }\n}\ninterface Api\nobject Single {}\nfun top() {}\n',
 ruby:'module M\n  class Shop\n    def open(n)\n      n\n    end\n  end\nend\ndef top; end\n',
 php:'<?php\nclass Shop {\n  public function open($n) {\n  }\n}\ninterface I {}\nfunction top() {}\n',
 c:'struct P { int x; };\nint add(int a,\n  int b) {\n  return a + b;\n}\nenum E { A };\n',
 cpp:'namespace n {\nclass Shop {\n public:\n  void open(int n) {}\n};\n}\nint top() { return 0; }\nvoid Shop::close() {}\n',
 scala:'object Shop {\n  def open(n: Int): Int = {\n    n\n  }\n}\nclass A\ntrait T\n',
 dart:'class Shop {\n  int open(int n) {\n    return n;\n  }\n}\nint top() {\n  return 0;\n}\n',
 lua:'local function helper(x)\n  return x\nend\nfunction M.open(n)\n  return n\nend\nfunction top()\nend\n',
 bash:'build() {\n  echo hi\n}\nfunction clean {\n  rm x\n}\n',
 elixir:'defmodule Shop do\n  def open(n) do\n    n\n  end\n  defp hidden(x), do: x\nend\n',
 zig:'const Shop = struct {\n    pub fn open(n: i32) i32 {\n        return n;\n    }\n};\nfn top() void {}\n',
 ocaml:'let add a b =\n  a + b\n\nmodule Shop = struct\n  let open_ n = n\nend\ntype t = int\n',
};
(async()=>{await m.Parser.init();for(const g of (process.argv[2]?process.argv.slice(2):Object.keys(S))){const l=await m.Language.load((require('fs').existsSync('grammars/tree-sitter-'+g+'.wasm')?'grammars/':W)+'tree-sitter-'+g+'.wasm');const p=new m.Parser();p.setLanguage(l);const t=p.parse(S[g]);
const out=[];const walk=(n,d)=>{if(d>5)return;for(const c of n.namedChildren){const nm=c.childForFieldName('name');out.push('  '.repeat(d)+c.type+(nm?` name=${nm.type}:${nm.text}`:'')+` [${c.startPosition.row+1}-${c.endPosition.row+1}]`);walk(c,d+1);}};walk(t.rootNode,0);
console.log('== '+g+'\n'+out.filter(x=>!/^ *(comment|string|number|integer|primitive_type|parameter_declaration|return_statement)/.test(x)).slice(0,40).join('\n'));}})()
