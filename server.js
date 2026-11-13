
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    app: "BET AGENT AI",
    status: "Serveur connecté"
  });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${date}`,
      {
        headers: {
          "x-apisports-key": process.env.API_FOOTBALL_KEY
        }
      }
    );

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Erreur API-Football"
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "Impossible de récupérer les matchs"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BET AGENT AI lancé sur le port ${PORT}`);
});
