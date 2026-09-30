// 여러 지자체에서 조례 수집과 이격거리 추출이 되는지 확인한다: npx tsx scripts/check-siting.ts
import { parseRegion } from "../lib/land";
import { findOrdinances, solarArticles } from "../lib/ordinance";
import { TARGET_LABEL, assess, extractSetbacks, type Land } from "../lib/siting";

const ADDRESSES = [
  "경상북도 영양군 영양읍 동부리",
  "전라남도 해남군 해남읍",
  "경기도 수원시 장안구 연무동",
  "서울특별시 강남구 역삼동",
  "세종특별자치시 조치원읍",
  "제주특별자치도 제주시 애월읍",
  "대구광역시 달성군 가창면",
  "충청남도 당진시 송악읍",
];

async function main() {
for (const address of ADDRESSES) {
  const { sido, sigungu } = parseRegion(address);
  const ords = await findOrdinances(sido, sigungu);
  const articles = (await Promise.all(ords.map(solarArticles))).flat();
  const { setbacks, slopes } = extractSetbacks(articles);
  console.log(`\n== ${address} → [${sido}] [${sigungu}]`);
  for (const o of ords) console.log(`  조례: ${o.name} (${o.org}, 시행 ${o.enforced})`);
  console.log(`  관련 조문 ${articles.length}개`);
  for (const s of setbacks) console.log(`  이격 ${TARGET_LABEL[s.target]} ${s.meters}m · ${s.article} · ${s.text.slice(0, 70)}`);
  for (const s of slopes) console.log(`  경사 ${s.degrees}° · ${s.article}`);
  const land: Land = { pnu: null, address, sido, sigungu, jimok: "임야", zones: ["계획관리지역"], areas: ["준보전산지"], areaM2: null, terrain: null, point: null, source: "manual" };
  const r = assess(land, setbacks, slopes, { road: 600, residential: 100 });
  console.log(`  판정(임야·계획관리, 도로 600m·주거 100m 가정): ${r.level}`);
}
}

main();
