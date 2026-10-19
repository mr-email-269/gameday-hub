(function(){"use strict";
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function inl(s){return s.replace(/`([^`]+)`/g,(m,c)=>`<code>${c}</code>`).replace(/\*\*([^*]+)\*\*/g,"<b>$1</b>")
  .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g,"$1<i>$2</i>").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')}
function md(src){const L=esc(src).split("\n"),o=[];let i=0;
  while(i<L.length){let l=L[i];
    if(/^```/.test(l)){const b=[];i++;while(i<L.length&&!/^```/.test(L[i]))b.push(L[i++]);i++;o.push(`<pre><code>${b.join("\n")}</code></pre>`);continue}
    if(/^\s*\|.*\|\s*$/.test(l)&&i+1<L.length&&/^\s*\|[\s:|-]+\|\s*$/.test(L[i+1])){const row=r=>r.trim().replace(/^\||\|$/g,"").split("|");
      let h=`<table><tr>${row(l).map(c=>`<th>${inl(c.trim())}</th>`).join("")}</tr>`;i+=2;
      while(i<L.length&&/^\s*\|/.test(L[i]))h+=`<tr>${row(L[i++]).map(c=>`<td>${inl(c.trim())}</td>`).join("")}</tr>`;o.push(h+"</table>");continue}
    const hm=l.match(/^(#{1,4})\s+(.*)/);if(hm){o.push(`<h${hm[1].length}>${inl(hm[2])}</h${hm[1].length}>`);i++;continue}
    if(/^\s*([-*•]|\d+\.)\s+/.test(l)){const ol=/^\s*\d+\./.test(l),b=[];
      while(i<L.length&&/^\s*([-*•]|\d+\.)\s+/.test(L[i]))b.push(`<li>${inl(L[i++].replace(/^\s*([-*•]|\d+\.)\s+/,""))}</li>`);
      o.push(ol?`<ol>${b.join("")}</ol>`:`<ul>${b.join("")}</ul>`);continue}
    if(!l.trim()){i++;continue}
    const b=[];while(i<L.length&&L[i].trim()&&!/^```|^#{1,4}\s|^\s*([-*•]|\d+\.)\s|^\s*\|/.test(L[i]))b.push(inl(L[i++]));o.push(`<p>${b.join("<br>")}</p>`)}
  return o.join("")}
window.DeskMd={md,inl};
})();
