(function () {
  async function initNavbar() {
    const cfgRes = await fetch("/api/config");
    const cfgData = await cfgRes.json();
    const SITE_NAME = cfgData.siteName || "Skylen Rank API";

    const meRes = await fetch("/auth/me");
    const me = await meRes.json();
    const loggedIn = me.loggedIn && !!me.user;

    const isManage = window.location.pathname.startsWith("/manage");

    const nav = document.getElementById("main-navbar");

    if (!loggedIn) {
      nav.innerHTML = `
        <div style="flex:1;display:flex;align-items:center;justify-content:center;">
          <a href="/" class="nav-brand" style="font-size:1.3rem;">${SITE_NAME}</a>
        </div>
      `;
      return;
    }

    nav.innerHTML = `
      <a href="/" class="nav-brand">${SITE_NAME}</a>

      <div class="nav-center">
        <div class="nav-icon-wrap ${!isManage ? 'nav-active' : ''}" onclick="window.location.href='/'">
          <img src="/pngs/home.png" alt="home" class="nav-icon-img"/>
          <span class="nav-icon-label">Ana Menü</span>
        </div>
        <div class="nav-icon-wrap ${isManage ? 'nav-active' : ''}" onclick="window.location.href='/manage'">
          <img src="/pngs/manage.png" alt="manage" class="nav-icon-img"/>
          <span class="nav-icon-label">Rütbeleri Yönet</span>
        </div>
      </div>

      <div class="nav-profile-area" onclick="window.location.href='/profile'">
        <img id="nav-avatar" src="" alt=""/>
        <span id="nav-username"></span>
      </div>
    `;

    const u = me.user;
    document.getElementById("nav-avatar").src = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
      : "https://cdn.discordapp.com/embed/avatars/0.png";
    document.getElementById("nav-username").textContent = u.username;
  }

  document.addEventListener("DOMContentLoaded", initNavbar);
})();