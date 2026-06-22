require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const RIOT_API_KEY = process.env.RIOT_API_KEY;

const PLATFORM_TO_REGION = {
  euw1: "europe", eun1: "europe", tr1: "europe", ru: "europe",
  na1: "americas", br1: "americas", la1: "americas", la2: "americas",
  kr: "asia", jp1: "asia",
};

async function riotFetch(url) {
  const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.status?.message || `Riot API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

app.get("/api/account", async (req, res) => {
  try {
    const { gameName, tagLine, platform = "euw1" } = req.query;
    if (!gameName || !tagLine) return res.status(400).json({ error: "gameName et tagLine requis" });
    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(`https://${region}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get("/api/matches", async (req, res) => {
  try {
    const { puuid, platform = "euw1", count = 10 } = req.query;
    if (!puuid) return res.status(400).json({ error: "puuid requis" });
    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(`https://${region}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`);
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get("/api/match/:matchId", async (req, res) => {
  try {
    const { matchId } = req.params;
    const { platform = "euw1" } = req.query;
    const region = PLATFORM_TO_REGION[platform] || "europe";
    const data = await riotFetch(`https://${region}.api.riotgames.com/lol/match/v5/matches/${matchId}`);
    res.json(data);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { rank, role, matchData, context } = req.body;
    const p = matchData.participant;
    const duration = Math.floor(matchData.gameDuration / 60) + "m" + (matchData.gameDuration % 60) + "s";
    const csPerMin = ((p.totalMinionsKilled + p.neutralMinionsKilled) / (matchData.gameDuration / 60)).toFixed(1);

    const statsBlock = `Champion: ${p.championName}
Résultat: ${p.win ? "Victoire" : "Défaite"} (${duration})
KDA: ${p.kills}/${p.deaths}/${p.assists}
CS: ${p.totalMinionsKilled + p.neutralMinionsKilled} (${csPerMin}/min)
Dégâts infligés: ${p.totalDamageDealtToChampions.toLocaleString()}
Vision score: ${p.visionScore}
Gold gagné: ${p.goldEarned.toLocaleString()}
Équipe alliée: ${matchData.team.map(t => t.championName).join(", ")}
Équipe adverse: ${matchData.enemies.map(e => e.championName).join(", ")}`;

    const prompt = `Tu es un coach League of Legends expert, spécialisé dans le coaching de joueurs ${rank}.
Le joueur évolue au poste ${role}.

Données officielles de la partie (API Riot) :
"""
${statsBlock}
"""

Ressenti du joueur :
"""
${context || "(aucun ressenti donné)"}
"""

Consignes strictes :
- Sois direct et factuel, comme un coach esport professionnel. Zéro complaisance.
- Identifie 2 à 4 erreurs de décision CONCRÈTES et actionnables — pas des généralités.
- Pour chaque erreur : contexte précis, pourquoi c'est une erreur, ce qu'il fallait faire.
- Distingue ce qui dépend du joueur de ce qui dépend des coéquipiers. Focus sur ce qu'il contrôle.
- Termine par UN SEUL objectif concret et mesurable pour la prochaine session.
- Adapte le niveau d'exigence au rang ${rank}.
- Réponds en français, structuré avec des titres courts. Maximum 400 mots.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(500).json({ error: claudeData.error?.message || "Erreur Claude" });
    const text = claudeData.content.map(b => b.type === "text" ? b.text : "").join("\n");
    res.json({ analysis: text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Serveur lancé sur le port ${PORT}`));
