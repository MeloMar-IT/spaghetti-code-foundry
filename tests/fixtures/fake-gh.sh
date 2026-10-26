#!/bin/sh
# Stand-in for the GitHub CLI. Logs every call to $FAKE_GH_LOG; "repo clone <url> <folder> -- <git flags>" clones $FAKE_GH_REMOTE into the folder.
# State lives next to the log: $FAKE_GH_LOG.pr (PR url once created), $FAKE_GH_LOG.checks (CI call count), $FAKE_GH_LOG.prs.json (open PRs;
# "pr list" honours --head and --limit on it), $FAKE_GH_LOG.bodies.json ({url: {title, body}}: set by "pr create" and "pr edit --body-file -",
# read by "pr view --json title,body").
# "pr edit --add-reviewer <handle>" only records the handle in $FAKE_GH_LOG.reviewers.json ({url: [handles]}); "pr view --json reviewRequests,reviews"
# answers from it ($FAKE_GH_REVIEWERS_FAIL=1 makes that view fail).
# $FAKE_GH_AUTH_LOG=<file>: every call appends one line, tab separated: GH_TOKEN, GITHUB_TOKEN, GH_ENTERPRISE_TOKEN (each "-" when unset),
# $FAKE_GH_LIST_LIMIT=<n>: "issue list" (not --search, not --state closed) returns at most the first n issues.
# "host" when GH_CONFIG_DIR is unset (else the number of entries in that folder), and the arguments.
if [ -n "$FAKE_GH_AUTH_LOG" ]; then
  if [ -z "${GH_CONFIG_DIR+x}" ]; then cfg=host; else cfg=$(ls -A "$GH_CONFIG_DIR" 2>/dev/null | wc -l | tr -d ' '); fi
  printf '%s\t%s\t%s\t%s\t%s\n' "${GH_TOKEN:--}" "${GITHUB_TOKEN:--}" "${GH_ENTERPRISE_TOKEN:--}" "$cfg" "$*" >> "$FAKE_GH_AUTH_LOG"
fi
echo "gh $*" >> "$FAKE_GH_LOG"
# $FAKE_GH_TOKEN_BY_REPO (JSON {"owner/name": "token"} or {"owner/name": ["token", …]}): a call for a listed repository whose GH_TOKEN is not
# accepted fails with 401. The repository is the --repo value, "api repos/<o>/<n>/…" or "repo view <o/n>".
if [ -n "$FAKE_GH_TOKEN_BY_REPO" ]; then
  tr_repo=""; tr_prev=""; for a in "$@"; do [ "$tr_prev" = "--repo" ] && tr_repo="$a"; tr_prev="$a"; done
  case "$1 $2" in "api repos/"*) tr_repo=${2#repos/}; tr_repo=$(echo "$tr_repo" | cut -d/ -f1-2) ;; "repo view") tr_repo=$3 ;; esac
  if [ -n "$tr_repo" ] && ! node -e 'const m=JSON.parse(process.env.FAKE_GH_TOKEN_BY_REPO)[process.argv[1]];if(m===undefined)process.exit(0);process.exit([].concat(m).includes(process.env.GH_TOKEN||"")?0:1)' "$tr_repo"; then
    echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1
  fi
fi
# $FAKE_GH_NO_USER=1: "api user" fails like it does for an app installation token.
if [ -n "$FAKE_GH_NO_USER" ] && [ "$1 $2" = "api user" ]; then echo "HTTP 403: Resource not accessible by integration (https://api.github.com/user)" >&2; exit 1; fi
# $FAKE_GH_EXPECT_TOKEN (set, also when empty): a call whose GH_TOKEN differs fails like GitHub does for a bad token.
if [ -n "${FAKE_GH_EXPECT_TOKEN+x}" ] && [ "$GH_TOKEN" != "$FAKE_GH_EXPECT_TOKEN" ]; then echo "HTTP 401: Bad credentials (https://api.github.com/graphql)" >&2; exit 1; fi
if [ -n "$FAKE_GH_SLEEP" ]; then sleep "$FAKE_GH_SLEEP"; fi
# $FAKE_GH_HOLD=<file>: the call waits while that file exists; $FAKE_GH_HOLD_ON=<text>: only a call with this text waits (empty: every call).
if [ -n "$FAKE_GH_HOLD" ]; then case "$*" in *"$FAKE_GH_HOLD_ON"*) while [ -e "$FAKE_GH_HOLD" ]; do sleep 0.05; done ;; esac; fi
# $FAKE_GH_HOLD2=<file> and $FAKE_GH_HOLD2_ON=<text>: the same, a second hold, so a test can release one call and keep another.
if [ -n "$FAKE_GH_HOLD2" ]; then case "$*" in *"$FAKE_GH_HOLD2_ON"*) while [ -e "$FAKE_GH_HOLD2" ]; do sleep 0.05; done ;; esac; fi
# $FAKE_GH_FAIL="issue list": that call prints $FAKE_GH_FAIL_TEXT (default "boom") to stderr and fails.
if [ -n "$FAKE_GH_FAIL" ] && [ "$FAKE_GH_FAIL" = "$1 $2" ]; then printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; fi
# "issue view <n> --repo R --json number,title,state,body" answers {number,title,state (upper-case),body} from $FAKE_GH_ISSUES (or the --repo list), or exits 1
# with "Could not resolve to an Issue". "issue edit <n> --body-file -" is logged as before and also stored in $FAKE_GH_LOG.issue-bodies.json
# ({"<repo>#<n>": body}, <repo> is the --repo value), so a later view shows the new body.
# $FAKE_GH_FAIL_ON=<text>: a call whose arguments contain this text prints $FAKE_GH_FAIL_TEXT (default "boom") to stderr and fails.
if [ -n "$FAKE_GH_FAIL_ON" ]; then case "$*" in *"$FAKE_GH_FAIL_ON"*) printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1 ;; esac; fi
# $FAKE_GH_LABEL_FILTER=1: a plain "issue list --label X" answers only the issues of $FAKE_GH_ISSUES that carry label X (else all of them).
# $FAKE_GH_ISSUES_BY_REPO (JSON {"owner/name": [issues]}): the issue lists and issue states are those of the --repo value.
# $FAKE_GH_COMMENTS_BY_ISSUE (JSON {"owner/name#4": {"comments": [...]}}): "issue view <n> --json comments,labels" answers with that entry.
# $FAKE_GH_COMMENTS_FROM_LOG=1: the same answer is built from the comments logged in $FAKE_GH_LOG when none of the above is set; its labels are those of the issue in $FAKE_GH_LOG.issues.json.
fake_repo=""; prev=""; for a in "$@"; do [ "$prev" = "--repo" ] && fake_repo="$a"; prev="$a"; done
if [ -n "$FAKE_GH_ISSUES_BY_REPO" ] && [ -n "$fake_repo" ]; then
  FAKE_GH_ISSUES=$(node -e 'const m=JSON.parse(process.env.FAKE_GH_ISSUES_BY_REPO);console.log(JSON.stringify(m[process.argv[1]]||[]))' "$fake_repo"); export FAKE_GH_ISSUES; unset FAKE_GH_FRESH
fi
# Edit or delete of a comment (gh api repos/…/issues/comments/<id> [-X DELETE]): logged, the edit with the body field of the JSON on stdin.
all="$*"
case "$all" in "api repos/"*"/issues/comments/"*)
  id=${all##*/issues/comments/}; id=${id%% *}
  case "$all" in
    *DELETE*) echo "--- comment delete $id" >> "$FAKE_GH_LOG" ;;
    *) echo "--- comment edit $id:" >> "$FAKE_GH_LOG"
       node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).body))' >> "$FAKE_GH_LOG" ;;
  esac
  echo '{}'; exit 0 ;;
esac
# REST calls for bug stories. State: $FAKE_GH_LOG.issues.json (issues made by the POST). $FAKE_GH_FAIL_API=list|read|create|update makes that call fail.
# "api repos/…/issues/<n> -X PATCH --input -" sets the title and body of that issue and logs "--- updated issue <n> (api):" with the JSON from stdin.
# $FAKE_GH_FAIL_CREATE_AT=<n>: the nth create call (the count is kept in $FAKE_GH_LOG.creates) fails with $FAKE_GH_FAIL_TEXT (default "boom").
api_fail() { [ "$FAKE_GH_FAIL_API" = "$1" ] && { printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; }; }
case "$all" in
  "api repos/"*"/issues -X POST --input -")
    api_fail create
    if [ -n "$FAKE_GH_FAIL_CREATE_AT" ]; then
      cn=$(($(cat "$FAKE_GH_LOG.creates" 2>/dev/null || echo 0) + 1)); echo "$cn" > "$FAKE_GH_LOG.creates"
      if [ "$cn" = "$FAKE_GH_FAIL_CREATE_AT" ]; then printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; fi
    fi
    repo=${all#api repos/}; repo=${repo%%/issues*}
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const b=JSON.parse(s);const n=Math.max(100,...l.map(x=>x.number))+1;const i={number:n,state:"open",state_reason:null,title:b.title,body:b.body,labels:(b.labels||[]).map(name=>({name})),html_url:"https://github.com/"+process.argv[2]+"/issues/"+n,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),closed_at:null};l.push(i);fs.writeFileSync(f,JSON.stringify(l));fs.appendFileSync(process.env.FAKE_GH_LOG,"--- created issue (api):\n"+s+"\n--- end issue\n");console.log(JSON.stringify(i))})' "$FAKE_GH_LOG.issues.json" "$repo"
    exit 0 ;;
  "api repos/"*"/issues?"*)
    api_fail list
    # A real page= parameter (not the one inside per_page=): filter by state=open, sort by number (direction=desc: highest first), slice.
    # state=all: starts with the issues of $FAKE_GH_ISSUES_BY_REPO[owner/name] (from the path), else $FAKE_GH_ISSUES, in the REST shape,
    # labels=a,b does the same merge, keeps only issues that carry every label, then applies state=open.
    # then adds the bug issues above whose number is not there yet, unchanged (so a test can plant a malformed one).
    case "$all" in *"?page="*|*"&page="*)
      node -e 'const fs=require("fs");const f=process.argv[1];const a=process.argv[2];const q=new URLSearchParams(a.slice(a.indexOf("?")+1));
let l=process.env.FAKE_GH_BUG_ISSUES?JSON.parse(process.env.FAKE_GH_BUG_ISSUES):fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];
if(q.get("state")==="all"||q.get("labels")){const repo=a.slice(6).split("/").slice(0,2).join("/");let base=[];
try{const by=process.env.FAKE_GH_ISSUES_BY_REPO?JSON.parse(process.env.FAKE_GH_ISSUES_BY_REPO)[repo]:undefined;base=by!==undefined?by:JSON.parse(process.env.FAKE_GH_ISSUES||"[]")}catch(e){base=[]}
if(!Array.isArray(base))base=[];
base=base.map(x=>({number:x.number,title:x.title,body:x.body,labels:x.labels||[],state:String(x.state||"open").toLowerCase(),state_reason:null,closed_at:null,created_at:x.createdAt||"2026-01-01T00:00:00Z",html_url:"https://github.com/"+repo+"/issues/"+x.number}));
const have=new Set(base.map(x=>x.number));l=[...base,...l.filter(x=>!have.has(x&&x.number))]}
if(q.get("labels")){const w=q.get("labels").split(",");l=l.filter(x=>w.every(n=>(x&&Array.isArray(x.labels)?x.labels:[]).some(y=>(typeof y==="string"?y:y&&y.name)===n)))}
if(q.get("state")==="open")l=l.filter(x=>x.state==="open");
const dir=q.get("direction")==="desc"?-1:1;l=l.slice().sort((x,y)=>dir*(((x&&x.number)||0)-((y&&y.number)||0)));const pp=Number(q.get("per_page")||30),p=Number(q.get("page"));console.log(JSON.stringify(l.slice((p-1)*pp,p*pp)))' "$FAKE_GH_LOG.issues.json" "$2"
      exit 0 ;;
    esac
    if [ -n "$FAKE_GH_BUG_ISSUES" ]; then printf '%s\n' "$FAKE_GH_BUG_ISSUES"
    elif [ -f "$FAKE_GH_LOG.issues.json" ]; then node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).reverse()))' "$FAKE_GH_LOG.issues.json"
    else echo '[]'; fi
    exit 0 ;;
  # Changes the title and text of an issue of $FAKE_GH_LOG.issues.json from the JSON on stdin (404 when it is not there). $FAKE_GH_FAIL_API=update fails it.
  "api repos/"*"/issues/"[0-9]*" -X PATCH --input -")
    api_fail update
    num=${all#*/issues/}; num=${num%% *}
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const i=l.find(x=>x.number===Number(process.argv[2]));if(!i){console.error("gh: Not Found (HTTP 404)");process.exit(1)}const b=JSON.parse(s);if(b.title!==undefined)i.title=b.title;if(b.body!==undefined)i.body=b.body;const now=new Date().toISOString();if(b.state!==undefined){i.state=b.state;i.state_reason=b.state_reason??(b.state==="closed"?"completed":null);i.closed_at=b.state==="closed"?now:null}i.updated_at=now;fs.writeFileSync(f,JSON.stringify(l));fs.appendFileSync(process.env.FAKE_GH_LOG,"--- "+(b.state!==undefined?"closed":"updated")+" issue "+i.number+" (api):\n"+s+"\n--- end issue\n");console.log(JSON.stringify(i))})' "$FAKE_GH_LOG.issues.json" "$num"
    exit $? ;;
  "api repos/"*"/issues/"[0-9]*)
    api_fail read
    node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const i=l.find(x=>x.number===Number(process.argv[2]));if(!i){console.error("gh: Not Found (HTTP 404)");process.exit(1)}console.log(JSON.stringify(i))' "$FAKE_GH_LOG.issues.json" "${all##*/issues/}"
    exit $? ;;
  # A pull request by number, from $FAKE_GH_LOG.pulls.json (a list of { number, state, merged }); 404 when the number is not in it.
  "api repos/"*"/pulls/"*[!0-9]*) ;; # a sub-path of a pull request (comments, …) is not answered here
  "api repos/"*"/pulls/"[0-9]*)
    api_fail read
    node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const p=l.find(x=>x.number===Number(process.argv[2]));if(!p){console.error("gh: Not Found (HTTP 404)");process.exit(1)}console.log(JSON.stringify({number:p.number,state:p.state,merged:p.merged===true,merged_at:p.merged===true?"2026-01-01T00:00:00Z":null}))' "$FAKE_GH_LOG.pulls.json" "${all##*/pulls/}"
    exit $? ;;
esac
# Main branch: "api repos/R/git/ref/heads/<branch>" answers $FAKE_GH_MAIN_SHA as the commit (404 when it is unset).
# "api repos/R/contents/.factory/release-build.yaml?ref=<sha>" answers a file when $FAKE_GH_RECIPE=1, else 404.
case "$1 $2" in
  "api repos/"*"/git/ref/heads/"*)
    if [ -z "$FAKE_GH_MAIN_SHA" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    printf '{"ref":"refs/heads/x","object":{"sha":"%s","type":"commit"}}\n' "$FAKE_GH_MAIN_SHA"; exit 0 ;;
  "api repos/"*"/contents/.factory/release-build.yaml?ref="*)
    if [ "$FAKE_GH_RECIPE" != 1 ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
    echo '{"type":"file","path":".factory/release-build.yaml"}'; exit 0 ;;
esac
# Releases. State: $FAKE_GH_LOG.releases.json, a list of { id, tag_name, draft, prerelease, created_at, body, html_url, upload_url, name, target_commitish,
# assets: [{ id, name, size, text? }] } (a test may write it first). Calls: "api --paginate repos/R/releases?per_page=100 --jq …" (one compact JSON line per
# release, ordered by $FAKE_GH_RELEASE_ORDER: newest (default), oldest or reverse-id), "api repos/R/releases/<id>" (404 when unknown), "api -X POST repos/R/releases
# -f/-F fields", "api -X DELETE repos/R/releases/<id>" and ".../releases/assets/<id>", and "api -X POST https://uploads.github.com/repos/R/releases/<id>/assets?name=X
# --input <file>" (an existing name: 422 already_exists). "release list|view|create|upload|delete" work on the same state; like the real gh, view, upload and delete
# find a tag among the PUBLISHED releases only. $FAKE_GH_FAIL_API=release-list|release-upload|release-delete makes that call fail.
REL_JS='const fs=require("fs");const f=process.argv[1];const a=process.argv.slice(2);
const load=()=>fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const save=(l)=>fs.writeFileSync(f,JSON.stringify(l,null,1));
const die=(m,c)=>{console.error(m);process.exit(c||1)};const failOn=(n)=>{if(process.env.FAKE_GH_FAIL_API===n)die(process.env.FAKE_GH_FAIL_TEXT||"boom")};
const l=load();const nextId=()=>Math.max(999,...l.map((x)=>x.id))+1;const nextAsset=()=>Math.max(4999,...l.flatMap((x)=>x.assets.map((y)=>y.id)))+1;
const stamp=()=>{const newest=Math.max(0,...l.map((x)=>Date.parse(x.created_at)));return new Date(Math.max(Date.now(),newest+1000)).toISOString()};
const view=(r)=>({id:r.id,tag_name:r.tag_name,draft:r.draft,prerelease:r.prerelease,created_at:r.created_at,html_url:r.html_url,upload_url:r.upload_url,body:r.body,assets:r.assets.map((x)=>({id:x.id,name:x.name,size:x.size}))});
const mk=(repo,o)=>{const id=nextId();const r={id,tag_name:o.tag,name:o.name||o.tag,target_commitish:o.target||"",draft:o.draft,prerelease:o.prerelease,created_at:stamp(),body:o.body||"",
 html_url:"https://github.com/"+repo+"/releases/tag/"+(o.draft?"untagged-"+id:o.tag),upload_url:"https://uploads.github.com/repos/"+repo+"/releases/"+id+"/assets{?name,label}",assets:[]};l.push(r);return r};
const addAsset=(r,name,file)=>{const st=fs.statSync(file);const x={id:nextAsset(),name,size:st.size};if(st.size<100000)x.text=fs.readFileSync(file,"utf8");r.assets.push(x);return x};
if(a[0]==="release"){const sub=a[1];const pos=[];const flags={};const files=[];
 for(let i=2;i<a.length;i++){const x=a[i];if(x==="--target"||x==="--notes"||x==="--title"||x==="-t"||x==="-n"||x==="--repo"||x==="-R"){flags[x]=a[++i]}else if(x.startsWith("-"))flags[x]=true;else pos.push(x)}
 const repo=flags["--repo"]||flags["-R"]||"owner/repo";
 if(sub==="list"){failOn("release-list");for(const r of l)console.log([r.name||r.tag_name,r.draft?"Draft":r.prerelease?"Pre-release":"Latest",r.tag_name,r.created_at].join("\t"));process.exit(0)}
 if(sub==="create"){const r=mk(repo,{tag:pos[0],draft:!!flags["--draft"],prerelease:!!flags["--prerelease"],target:flags["--target"],body:flags["--notes"],name:flags["--title"]});
  for(const p of pos.slice(1))addAsset(r,p.split("/").pop(),p);save(l);console.log(r.html_url);process.exit(0)}
 const pub=l.find((r)=>!r.draft&&r.tag_name===pos[0]);if(!pub)die("release not found");
 if(sub==="view"){console.log("title:\t"+pub.name+"\ntag:\t"+pub.tag_name+"\nurl:\t"+pub.html_url);process.exit(0)}
 if(sub==="upload"){failOn("release-upload");for(const p of pos.slice(1)){const name=p.split("/").pop();const old=pub.assets.findIndex((x)=>x.name===name);
   if(old>=0){if(!flags["--clobber"])die("a release asset named "+name+" already exists");pub.assets.splice(old,1)}addAsset(pub,name,p)}save(l);process.exit(0)}
 if(sub==="delete"){failOn("release-delete");save(l.filter((r)=>r!==pub));process.exit(0)}
 process.exit(99)}
let method="GET",path="",paginate=false,input="";const fields={};
for(let i=1;i<a.length;i++){const x=a[i];if(x==="-X")method=a[++i];else if(x==="-f"||x==="-F"){const kv=a[++i];const k=kv.indexOf("=");fields[kv.slice(0,k)]=kv.slice(k+1)}
 else if(x==="--paginate")paginate=true;else if(x==="--jq"||x==="-H"||x==="--hostname")i++;else if(x==="--input")input=a[++i];else path=x}
if(Object.keys(fields).length&&method==="GET")method="POST";
let m;const nf=()=>die("gh: Not Found (HTTP 404)");
if(m=/^https:\/\/uploads\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/(\d+)\/assets\?(.*)$/.exec(path)){failOn("release-upload");
 const r=l.find((x)=>x.id===Number(m[2]));if(!r)nf();const name=new URLSearchParams(m[3]).get("name");
 if(!input||!fs.existsSync(input))die("gh: no such file: "+input);
 if(r.assets.some((x)=>x.name===name))die("gh: Validation Failed (HTTP 422)\n{\"errors\":[{\"code\":\"already_exists\",\"field\":\"name\"}]}");
 const x=addAsset(r,name,input);save(l);console.log(JSON.stringify({id:x.id,name:x.name,size:x.size}));process.exit(0)}
if(m=/^repos\/([^/]+\/[^/]+)\/releases\?per_page=100$/.exec(path)){failOn("release-list");const order=process.env.FAKE_GH_RELEASE_ORDER||"newest";
 const s=l.slice().sort((x,y)=>order==="oldest"?Date.parse(x.created_at)-Date.parse(y.created_at):order==="reverse-id"?y.id-x.id:Date.parse(y.created_at)-Date.parse(x.created_at));
 for(const r of s)console.log(JSON.stringify(view(r)));process.exit(0)}
if(m=/^repos\/([^/]+\/[^/]+)\/releases$/.exec(path)){if(method!=="POST")process.exit(99);
 const r=mk(m[1],{tag:fields.tag_name,name:fields.name,target:fields.target_commitish,body:fields.body,draft:fields.draft==="true",prerelease:fields.prerelease==="true"});save(l);console.log(JSON.stringify(view(r)));process.exit(0)}
if(m=/^repos\/([^/]+\/[^/]+)\/releases\/assets\/(\d+)$/.exec(path)){if(method!=="DELETE")process.exit(99);failOn("release-delete");
 const r=l.find((x)=>x.assets.some((y)=>y.id===Number(m[2])));if(!r)nf();r.assets=r.assets.filter((y)=>y.id!==Number(m[2]));save(l);process.exit(0)}
if(m=/^repos\/([^/]+\/[^/]+)\/releases\/(\d+)$/.exec(path)){const r=l.find((x)=>x.id===Number(m[2]));
 if(method==="DELETE"){failOn("release-delete");if(!r)nf();save(l.filter((x)=>x!==r));process.exit(0)}
 if(method!=="GET")process.exit(99);if(!r)nf();console.log(JSON.stringify(view(r)));process.exit(0)}
process.exit(99)'
case "$all" in "release "*|"api "*"releases"*)
  node -e "$REL_JS" "$FAKE_GH_LOG.releases.json" "$@"; rc=$?
  [ "$rc" -ne 99 ] && exit "$rc" ;;
esac
# $FAKE_GH_STORIES=1: the issues made by the REST POST (bug stories) are real to "issue list/view/close" too. Without it, nothing here runs.
# list: $FAKE_GH_ISSUES plus the open stories with the --label; view/close: for a number found in $FAKE_GH_LOG.issues.json.
STORY_JS='const fs=require("fs"),f=process.argv[1],[mode,...a]=process.argv.slice(2);const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const i=l.find(x=>x.number===Number(a[0]));
if(mode==="has")process.exit(i?0:1);
if(mode==="list"){const base=JSON.parse(process.env.FAKE_GH_ISSUES||"[]");const extra=l.filter(x=>x.state==="open"&&x.labels.some(y=>y.name===a[0])).map(x=>({number:x.number,title:x.title,body:x.body,labels:x.labels,createdAt:x.created_at,state:"OPEN"}));console.log(JSON.stringify([...base,...extra]))}
if(mode==="labels")console.log(i.labels.map(y=>y.name).join("\n"));
if(mode==="title")console.log(i.title);
if(mode==="text")console.log("# #"+i.number+": "+i.title+"\n"+i.html_url+"\nLabels: "+i.labels.map(y=>y.name).join(", ")+"\n\n"+i.body);
if(mode==="close"){i.state="closed";i.state_reason=a[1]||"completed";i.closed_at=new Date().toISOString();fs.writeFileSync(f,JSON.stringify(l))}'
story() { node -e "$STORY_JS" "$FAKE_GH_LOG.issues.json" "$@"; }
if [ -n "$FAKE_GH_STORIES" ]; then
  case "$1 $2" in
    "issue list") case "$*" in *"--state closed"*|*"--search"*) ;;
      *) lab=""; prev=""; for a in "$@"; do [ "$prev" = "--label" ] && lab="$a"; prev="$a"; done
         story list "$lab"; exit 0 ;; esac ;;
    "issue view") if story has "$3" 2>/dev/null; then
      case "$*" in *"--json labels --jq"*) story labels "$3"; exit 0 ;; *"-q .title"*) story title "$3"; exit 0 ;;
        *"--json number,title,body"*) story text "$3"; exit 0 ;; # pull_ticket (its jq would build this text)
        *"--json"*) ;; *) story text "$3"; exit 0 ;; esac; fi ;;
    "issue close") if story has "$3" 2>/dev/null; then
      reason=completed; prev=""; for a in "$@"; do [ "$prev" = "--reason" ] && reason="$a"; prev="$a"; done
      story close "$3" "$reason"; exit 0; fi ;;
  esac
fi
# "api graphql --input -": issue states. Answers every alias i<N> from $FAKE_GH_FRESH, else $FAKE_GH_ISSUES_BY_REPO[owner/name], else $FAKE_GH_ISSUES; default OPEN.
# $FAKE_GH_GRAPHQL_MISSING="7 9": those aliases are null with a NOT_FOUND error, as gh prints it (exit 1). $FAKE_GH_GRAPHQL_MAX=<n>: a query with more aliases is refused.
# $FAKE_GH_GRAPHQL_FAIL_AFTER=<n>: the calls after the first n fail.
case "$all" in "api graphql"*)
  gn=$(($(cat "$FAKE_GH_LOG.graphql" 2>/dev/null || echo 0) + 1)); echo "$gn" > "$FAKE_GH_LOG.graphql"
  if [ -n "$FAKE_GH_GRAPHQL_FAIL_AFTER" ] && [ "$gn" -gt "$FAKE_GH_GRAPHQL_FAIL_AFTER" ]; then echo "gh: HTTP 502" >&2; exit 1; fi
  node -e '
    const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const e = process.env, q = input.query || "", v = input.variables || {};
    const aliases = [...q.matchAll(/i(\d+): issue\(number: (\d+)\)/g)];
    if (e.FAKE_GH_GRAPHQL_MAX && aliases.length > Number(e.FAKE_GH_GRAPHQL_MAX)) { console.error("gh: query too large"); process.exit(1); }
    let list;
    if (e.FAKE_GH_ISSUES_BY_REPO) list = JSON.parse(e.FAKE_GH_ISSUES_BY_REPO)[v.owner + "/" + v.name] || [];
    else list = JSON.parse(e.FAKE_GH_FRESH || e.FAKE_GH_ISSUES || "[]");
    const missing = (e.FAKE_GH_GRAPHQL_MISSING || "").split(/\s+/).filter(Boolean);
    const repository = {}, errors = [];
    for (const m of aliases) {
      const n = Number(m[2]);
      if (missing.includes(String(n))) { repository["i" + n] = null; errors.push({ type: "NOT_FOUND", path: ["repository", "i" + n], message: "Could not resolve to an Issue with the number of " + n + "." }); continue; }
      const found = list.find((x) => x.number === n);
      repository["i" + n] = { state: String((found && found.state) || "OPEN").toUpperCase() };
    }
    const body = { data: { repository } };
    if (errors.length) { body.errors = errors; console.log(JSON.stringify(body)); console.error("gh: Could not resolve to an Issue"); process.exit(1); }
    console.log(JSON.stringify(body));
  '
  exit $? ;;
esac
# "api repos/<o>/<n>/labels?…": the label names, one per line, from $FAKE_GH_LOG.labels (nothing when the file is not there).
case "$all" in "api repos/"*"/labels?"*) cat "$FAKE_GH_LOG.labels" 2>/dev/null; exit 0 ;; esac
case "$all" in "api rate_limit") if [ -n "$FAKE_GH_RATE_LIMIT" ]; then printf '%s\n' "$FAKE_GH_RATE_LIMIT"; else echo '{"resources":{}}'; fi; exit 0 ;; esac
case "$1 $2" in
  "repo view")
    case "$*" in *--jq*|*nameWithOwner*) echo "repo: owner/repo"; echo "default branch: main" ;;
      *defaultBranchRef*) echo '{"defaultBranchRef":{"name":"main"}}' ;;
      *) echo "repo: owner/repo" ;;
    esac ;;
  "issue view")
    case "$*" in
      *"--json number,title,state,body"*) node -e 'const fs=require("fs");const [n,repo,f]=process.argv.slice(1);const l=JSON.parse(process.env.FAKE_GH_ISSUES||"[]");const i=l.find(x=>x.number===Number(n));
if(!i){console.error("GraphQL: Could not resolve to an Issue with the number of "+n+". (repository.issue)");process.exit(1)}
const m=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};const k=repo+"#"+n;
console.log(JSON.stringify({number:i.number,title:i.title,state:String(i.state||"OPEN").toUpperCase(),body:k in m?m[k]:(i.body||"")}))' "$3" "$fake_repo" "$FAKE_GH_LOG.issue-bodies.json" || exit 1 ;;
      *"-q .title"*) echo "Add a feature" ;;
      *"--json labels --jq"*) [ -n "$FAKE_GH_FAIL_LABELS" ] && { echo boom >&2; exit 1; }; printf '%s\n' ${FAKE_GH_ISSUE_LABELS:-} ;;
      *"--json state") node -e 'const n=Number(process.argv[1]);const l=JSON.parse(process.env.FAKE_GH_FRESH||process.env.FAKE_GH_ISSUES||"[]");const i=l.find(x=>x.number===n)||{state:"OPEN"};console.log(JSON.stringify({state:i.state||"OPEN"}))' "$3" ;;
      *"--json state,labels"*) node -e 'const n=Number(process.argv[1]);const l=JSON.parse(process.env.FAKE_GH_FRESH||process.env.FAKE_GH_ISSUES||"[]");const i=l.find(x=>x.number===n)||{state:"OPEN",labels:[]};console.log(JSON.stringify({state:i.state||"OPEN",labels:i.labels||[]}))' "$3" ;;
      *"--json title,body,labels,comments"*) c=${FAKE_GH_PARENT:-}; [ -n "$c" ] || c='{"title":"Add a feature","body":"**Epic:** Updates\n\nPlease add feature.txt","labels":[{"name":"enhancement"},{"name":"Factory_go"},{"name":"Factory_working"}],"comments":[]}'; printf '%s' "$c" ;;
      *"--json comments,labels"*) c=""
         if [ -n "$FAKE_GH_COMMENTS_BY_ISSUE" ]; then c=$(node -e 'const v=JSON.parse(process.env.FAKE_GH_COMMENTS_BY_ISSUE)[process.argv[1]];if(v)console.log(JSON.stringify(v))' "$fake_repo#$3"); fi
         [ -n "$c" ] || c=${FAKE_GH_COMMENTS:-}
         # FAKE_GH_COMMENTS_FROM_LOG=1: the comments of issue <n> as logged by "issue comment" (numbered like the printed #issuecomment-<n>), minus deleted ones.
         if [ -z "$c" ] && [ -n "$FAKE_GH_COMMENTS_FROM_LOG" ] && [ -f "$FAKE_GH_LOG" ]; then c=$(node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");const issue=process.argv[2];const gone=new Set([...t.matchAll(/^--- comment delete (\d+)$/gm)].map(m=>m[1]));let n=0;const out=[];for(const m of t.matchAll(/^--- comment on #(\d+):\n([\s\S]*?)\n--- end comment$/gm)){n++;if(m[1]!==issue||gone.has(String(n)))continue;out.push({body:m[2],url:"https://github.com/owner/repo/issues/"+issue+"#issuecomment-"+n,viewerDidAuthor:true})}let labels=[];try{const l=JSON.parse(require("fs").readFileSync(process.argv[1]+".issues.json","utf8"));labels=(l.find(x=>x.number===Number(issue))||{}).labels||[]}catch{}console.log(JSON.stringify({comments:out,labels}))' "$FAKE_GH_LOG" "$3"); fi
         [ -n "$c" ] || c='{"comments":[]}'; printf '%s' "$c" ;;
      *"--json state"*) echo "${FAKE_GH_ISSUE_STATE:-OPEN}" ;;
      # FAKE_GH_ISSUE_BODIES: JSON {"<number>": "<body>"}; the body replaces "Please add feature.txt" for that issue (the pull_ticket text).
      *"--json body --jq .body"*) node -e 'const v=JSON.parse(process.env.FAKE_GH_ISSUE_BODIES||"{}")[process.argv[1]];process.stdout.write((typeof v==="string"?v:"Please add feature.txt")+"\n")' "$3" ;;
      *) b=$(node -e 'const v=JSON.parse(process.env.FAKE_GH_ISSUE_BODIES||"{}")[process.argv[1]];process.stdout.write(typeof v==="string"?v:"Please add feature.txt")' "$3")
         printf '# #%s: Add a feature\nhttps://github.com/owner/repo/issues/%s\n\n%s\n' "$3" "$3" "$b"
         if [ -n "$FAKE_GH_ISSUE_EXTRA" ]; then printf '%s\n' "$FAKE_GH_ISSUE_EXTRA"; fi ;;
    esac ;;
  "issue comment"|"pr comment") echo "--- comment on #$3:" >> "$FAKE_GH_LOG"
    case "$*" in *--body-file*) cat >> "$FAKE_GH_LOG" ;;
      *) prev=""; for a in "$@"; do [ "$prev" = "--body" ] && printf '%s\n' "$a" >> "$FAKE_GH_LOG"; prev="$a"; done ;;
    esac
    printf '\n--- end comment\n' >> "$FAKE_GH_LOG" # a body may end without a line end
    cn=$(($(cat "$FAKE_GH_LOG.comments" 2>/dev/null || echo 0) + 1)); echo "$cn" > "$FAKE_GH_LOG.comments"
    echo "https://github.com/owner/repo/issues/$3#issuecomment-$cn" ;;
  "issue create") n=$(($(cat "$FAKE_GH_LOG.created" 2>/dev/null || echo 100) + 1)); echo "$n" > "$FAKE_GH_LOG.created"
                  echo "--- created issue: $*" >> "$FAKE_GH_LOG"; case "$*" in *--body-file*) cat >> "$FAKE_GH_LOG" ;; esac
                  echo "https://github.com/owner/repo/issues/$n" ;;
  "issue close") ;;
  "issue list")  case "$*" in *"--state closed"*) printf '%s' "${FAKE_GH_CLOSED_ISSUES:-[]}" ;;
                   *"--search"*) printf '%s' "${FAKE_GH_PRIORITY_ISSUES:-${FAKE_GH_ISSUES:-[]}}" ;;
                   *) if [ -n "$FAKE_GH_LABEL_FILTER" ]; then
                        lab=""; prev=""; for a in "$@"; do [ "$prev" = "--label" ] && lab="$a"; prev="$a"; done
                        node -e 'const l=JSON.parse(process.env.FAKE_GH_ISSUES||"[]"),w=process.argv[1];process.stdout.write(JSON.stringify(w?l.filter(i=>(i.labels||[]).some(y=>y.name===w)):l))' "$lab"
                      else printf '%s' "${FAKE_GH_ISSUES:-[]}"; fi | { if [ -n "$FAKE_GH_LIST_LIMIT" ]; then node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).slice(0,Number(process.argv[1])))))' "$FAKE_GH_LIST_LIMIT"; else cat; fi; } ;; esac ;;
  "pr list")     case "$*" in *"--state merged"*) printf '%s' "${FAKE_GH_MERGED_PRS:-[]}"; exit 0 ;; esac
                 if [ -n "$FAKE_GH_PRS" ]; then printf '%s' "$FAKE_GH_PRS"; elif [ -f "$FAKE_GH_LOG.prs.json" ]; then
                   # --head <branch> keeps the PRs of that branch, --limit <n> the first n of them (the order of the file).
                   lim=""; hd=""; prev=""; for a in "$@"; do [ "$prev" = "--limit" ] && lim="$a"; [ "$prev" = "--head" ] && hd="$a"; prev="$a"; done
                   node -e 'const fs=require("fs");let l=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const [lim,hd]=[process.argv[2],process.argv[3]];if(hd)l=l.filter(x=>x.headRefName===hd);if(lim)l=l.slice(0,Number(lim));process.stdout.write(JSON.stringify(l))' "$FAKE_GH_LOG.prs.json" "$lim" "$hd"
                 else echo '[]'; fi ;;
  "issue edit") case "$*" in *--body-file*) echo "--- issue body edit: $*" >> "$FAKE_GH_LOG"; cat > "$FAKE_GH_LOG.editbody"; cat "$FAKE_GH_LOG.editbody" >> "$FAKE_GH_LOG"
      node -e 'const fs=require("fs");const [n,repo,f,b]=process.argv.slice(1);const m=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};m[repo+"#"+n]=fs.readFileSync(b,"utf8");fs.writeFileSync(f,JSON.stringify(m))' "$3" "$fake_repo" "$FAKE_GH_LOG.issue-bodies.json" "$FAKE_GH_LOG.editbody" ;; esac
    # --add-label / --remove-label change the labels of an issue of $FAKE_GH_LOG.issues.json (an issue that is not there is left alone).
    case "$*" in *-label*) node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const i=l.find(x=>x.number===Number(process.argv[2]));if(!i)process.exit(0);const a=process.argv.slice(3);for(let k=0;k<a.length;k++){if(a[k]==="--remove-label")i.labels=i.labels.filter(y=>y.name.toLowerCase()!==a[k+1].toLowerCase());if(a[k]==="--add-label"&&!i.labels.some(y=>y.name.toLowerCase()===a[k+1].toLowerCase()))i.labels.push({name:a[k+1]})}fs.writeFileSync(f,JSON.stringify(l))' "$FAKE_GH_LOG.issues.json" "$3" "$@" ;; esac ;;
  "label create") name=$3 # names are kept in $FAKE_GH_LOG.labels; without --force an existing one is an error
    case "$*" in *--force*) grep -qxF -- "$name" "$FAKE_GH_LOG.labels" 2>/dev/null || echo "$name" >> "$FAKE_GH_LOG.labels" ;;
      *) if grep -qxF -- "$name" "$FAKE_GH_LOG.labels" 2>/dev/null; then echo "label with name \"$name\" already exists; use --force to update its color and description" >&2; exit 1; fi
         echo "$name" >> "$FAKE_GH_LOG.labels" ;;
    esac ;;
  "pr edit")     case "$*" in *--add-reviewer*) rv=""; prev=""; for a in "$@"; do [ "$prev" = "--add-reviewer" ] && rv="$a"; prev="$a"; done
                   node -e 'const f=process.argv[1],fs=require("fs");const m=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};const u=process.argv[2];m[u]=[...new Set([...(m[u]||[]),process.argv[3]])];fs.writeFileSync(f,JSON.stringify(m))' "$FAKE_GH_LOG.reviewers.json" "$3" "$rv"; exit 0 ;; esac
                 echo "--- pr edit: $*" >> "$FAKE_GH_LOG"; cat > "$FAKE_GH_LOG.lastbody"; cat "$FAKE_GH_LOG.lastbody" >> "$FAKE_GH_LOG"; printf '\n--- end pr edit\n' >> "$FAKE_GH_LOG"
                 # "--body-file -" stores the new title (--title, else the old one) and body of the PR in $FAKE_GH_LOG.bodies.json.
                 case "$*" in *"--body-file -"*) title=""; prev=""; for a in "$@"; do [ "$prev" = "--title" ] && title="$a"; prev="$a"; done
                   node -e 'const f=process.argv[1],fs=require("fs");const m=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};const u=process.argv[2];const old=m[u]||{title:""};m[u]={title:process.argv[3]||old.title,body:fs.readFileSync(process.argv[4],"utf8")};fs.writeFileSync(f,JSON.stringify(m))' "$FAKE_GH_LOG.bodies.json" "$3" "$title" "$FAKE_GH_LOG.lastbody" ;; esac ;;
  "pr ready")    ;;
  "repo clone")  # the folder is $4; the flags after "--" go to git clone, as in the real gh (the remote is a local folder, so any GIT_ALLOW_PROTOCOL is dropped)
                 dest="$4"; shift 4; [ "$1" = "--" ] && shift
                 ( unset GIT_ALLOW_PROTOCOL; git clone "$@" "$FAKE_GH_REMOTE" "$dest" ) ;;
  "pr create")   echo "--- pr body:" >> "$FAKE_GH_LOG"; cat > "$FAKE_GH_LOG.lastbody"; cat "$FAKE_GH_LOG.lastbody" >> "$FAKE_GH_LOG"
                 head=""; title=""; prev=""; for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; [ "$prev" = "--title" ] && title="$a"; prev="$a"; done
                 # Remember created PRs (pr list returns them): number, head branch, state OPEN.
                 node -e 'const f=process.argv[1],fs=require("fs");const l=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):[];const n=99+l.length;l.push({number:n,headRefName:process.argv[2],state:"OPEN",createdAt:new Date(Date.UTC(2026,5,1)+n*60000).toISOString(),url:"https://github.com/owner/repo/pull/"+n});fs.writeFileSync(f,JSON.stringify(l));const b=process.argv[5];const m=fs.existsSync(b)?JSON.parse(fs.readFileSync(b,"utf8")):{};m[l.at(-1).url]={title:process.argv[3],body:fs.readFileSync(process.argv[4],"utf8")};fs.writeFileSync(b,JSON.stringify(m));console.log(l.at(-1).url)' "$FAKE_GH_LOG.prs.json" "$head" "$title" "$FAKE_GH_LOG.lastbody" "$FAKE_GH_LOG.bodies.json" | tee "$FAKE_GH_LOG.pr"
                 # $FAKE_GH_CREATE_THEN_FAIL=1: the PR above is recorded, then the call fails like gh does when it dies after creating it.
                 if [ -n "$FAKE_GH_CREATE_THEN_FAIL" ]; then printf '%s\n' "${FAKE_GH_FAIL_TEXT:-boom}" >&2; exit 1; fi ;;
  "pr view")
    case "$*" in
      *reviewRequests,reviews*) [ -n "$FAKE_GH_REVIEWERS_FAIL" ] && { echo boom >&2; exit 1; }
        node -e 'const f=process.argv[1],fs=require("fs");const m=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};console.log(JSON.stringify({reviewRequests:(m[process.argv[2]]||[]).map(login=>({__typename:"User",login})),reviews:[]}))' "$FAKE_GH_LOG.reviewers.json" "$3" ;;
      *"--json title,body"*) node -e 'const f=process.argv[1],fs=require("fs");const m=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{};const v=m[process.argv[2]];if(!v)process.exit(1);console.log(JSON.stringify(v))' "$FAKE_GH_LOG.bodies.json" "$3" || exit 1 ;;
      *reviewDecision*) echo "${FAKE_GH_REVIEW_DECISION:-}" ;;
      *comments,reviews,commits*) printf '%s' "${FAKE_GH_PR_VIEW:-{\"comments\":[],\"reviews\":[],\"commits\":[]\}}" ;;
      *reviews,comments*) printf '%s\n' "${FAKE_GH_PR_COMMENTS:---- alice:\nplease rename x}" ;;
      *number,title,body*) echo "# PR #$3 Some change" ;;
      *url*) [ -f "$FAKE_GH_LOG.pr" ] && cat "$FAKE_GH_LOG.pr" || exit 1 ;;
      *) exit 1 ;;
    esac ;;
  "pr checks")
    n=$(($(cat "$FAKE_GH_LOG.checks" 2>/dev/null || echo 0) + 1)); echo "$n" > "$FAKE_GH_LOG.checks"
    if [ -n "$FAKE_GH_CI_FAILS" ] && [ "$n" -le "$FAKE_GH_CI_FAILS" ]; then echo "test  fail  1m"; exit 1; fi
    echo "test  pass  1m" ;;
  "run list")    case "$*" in *workflowName*) printf '%s' "${FAKE_GH_RUNS:-[]}" ;; *) echo 123 ;; esac ;;
  "run view")    echo "FAIL src/app.test.js: expected 2, got 3" ;;
  "pr merge")    echo "merged" ;;
  "pr checkout") git fetch -q origin "factory/pr-$3" && git checkout -q -B "factory/pr-$3" FETCH_HEAD && git branch -q --set-upstream-to="origin/factory/pr-$3" 2>/dev/null; git config "branch.factory/pr-$3.remote" origin; git config "branch.factory/pr-$3.merge" "refs/heads/factory/pr-$3" ;;
  "api "*)       case "$2" in user) echo "${FAKE_GH_LOGIN:-foundry-owner}" ;; *permission*) l=${2#*collaborators/}; l=${l%/permission}
                       # $FAKE_GH_READONLY: logins that only have read access
                       case " $FAKE_GH_READONLY " in *" $l "*) echo read ;; *) echo "${FAKE_GH_PERMISSION:-write}" ;; esac ;; *) printf '%s' "${FAKE_GH_API:-[]}" ;; esac ;;
  *) echo "fake gh: unsupported: $*" >&2; exit 1 ;;
esac
