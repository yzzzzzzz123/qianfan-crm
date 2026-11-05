import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

// Scope the same Arco styles used by SparNow to this widget and its popup.
const scopedCalendarStyles={
  postcssPlugin:'qianfan-calendar-scope',
  Rule(rule){
    if(rule.parent?.type==='atrule'&&/keyframes$/i.test(rule.parent.name))return;
    if(rule.selectors.every(selector=>selector.includes('.qf-minutes-calendar')))return;
    rule.selectors=rule.selectors.map(selector=>{
      if(selector.includes('.qf-minutes-calendar'))return selector;
      const scopedRoot=selector.replace(/(?<![\w.-])(?:body|html|:root)(?![\w-])/g,'.qf-minutes-calendar');
      if(scopedRoot!==selector)return scopedRoot;
      return `:where(.qf-minutes-calendar) ${selector}`;
    });
  },
};
export default defineConfig({
  publicDir:false,
  plugins:[{name:'calendar-third-party-notices',generateBundle(){this.emitFile({type:'asset',fileName:'THIRD_PARTY_NOTICES.txt',source:readFileSync(new URL('./THIRD_PARTY_NOTICES.txt',import.meta.url),'utf8')});}}],
  css:{postcss:{plugins:[scopedCalendarStyles]}},
  define:{'process.env.NODE_ENV':JSON.stringify('production')},
  build:{
    outDir:fileURLToPath(new URL('../public/widgets',import.meta.url)),emptyOutDir:true,
    lib:{entry:fileURLToPath(new URL('./minutes-date-range.jsx',import.meta.url)),formats:['es'],fileName:()=> 'minutes-date-range.js',cssFileName:'minutes-date-range'},
    minify:true,cssMinify:true,
  },
});
