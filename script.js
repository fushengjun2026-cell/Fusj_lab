const canvas = document.querySelector("#starfield");
const context = canvas.getContext("2d");
const meteorLayer = document.querySelector("#meteor-layer");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let stars = [];
let width = 0;
let height = 0;
let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
let animationFrame = null;

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

function resizeCanvas() {
    width = window.innerWidth;
    height = window.innerHeight;
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

    createStars();
}

function createStars() {
    const starCount = Math.min(Math.floor((width * height) / 3600), 360);

    stars = Array.from({ length: starCount }, () => {
        const depth = Math.random();

        return {
            x: Math.random() * width,
            y: Math.random() * height,
            radius: randomBetween(0.45, 1.85) * (0.55 + depth),
            alpha: randomBetween(0.22, 0.95),
            speed: randomBetween(0.012, 0.045) * (0.4 + depth),
            twinkle: randomBetween(0, Math.PI * 2),
            drift: randomBetween(0.03, 0.18) * (0.4 + depth),
            hue: Math.random() > 0.72 ? "199, 246, 255" : "255, 255, 255"
        };
    });
}

function renderStars(time = 0) {
    context.clearRect(0, 0, width, height);

    const nebula = context.createRadialGradient(width * 0.5, height * 0.38, 0, width * 0.5, height * 0.38, Math.max(width, height) * 0.7);
    nebula.addColorStop(0, "rgba(28, 52, 92, 0.14)");
    nebula.addColorStop(0.44, "rgba(8, 18, 34, 0.08)");
    nebula.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.fillStyle = nebula;
    context.fillRect(0, 0, width, height);

    stars.forEach((star) => {
        star.twinkle += star.speed;
        star.y += star.drift;

        if (star.y > height + 4) {
            star.y = -4;
            star.x = Math.random() * width;
        }

        const glow = star.alpha + Math.sin(star.twinkle + time * 0.00045) * 0.22;
        context.beginPath();
        context.fillStyle = `rgba(${star.hue}, ${Math.max(0.08, Math.min(1, glow))})`;
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
    });

    animationFrame = requestAnimationFrame(renderStars);
}

function createMeteor() {
    if (prefersReducedMotion || !meteorLayer) {
        return;
    }

    const meteor = document.createElement("span");
    const fromLeft = Math.random() > 0.5;
    const startX = fromLeft ? randomBetween(-220, width * 0.2) : randomBetween(width * 0.68, width + 120);
    const startY = randomBetween(-20, height * 0.58);
    const travelX = fromLeft ? randomBetween(width * 0.7, width * 1.25) : -randomBetween(width * 0.7, width * 1.25);
    const travelY = randomBetween(height * 0.26, height * 0.72);
    const duration = randomBetween(900, 1550);
    const angle = Math.atan2(travelY, travelX) * (180 / Math.PI);

    meteor.className = "meteor";
    meteor.style.left = `${startX}px`;
    meteor.style.top = `${startY}px`;
    meteor.style.setProperty("--travel-x", `${travelX}px`);
    meteor.style.setProperty("--travel-y", `${travelY}px`);
    meteor.style.setProperty("--duration", `${duration}ms`);
    meteor.style.setProperty("--angle", `${angle}deg`);

    meteorLayer.appendChild(meteor);
    window.setTimeout(() => meteor.remove(), duration + 120);
}

function scheduleMeteor() {
    if (prefersReducedMotion) {
        return;
    }

    createMeteor();
    window.setTimeout(scheduleMeteor, randomBetween(950, 3200));
}

function revealOnScroll() {
    const elements = document.querySelectorAll(".reveal");

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                observer.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.18,
        rootMargin: "0px 0px -70px 0px"
    });

    elements.forEach((element) => observer.observe(element));
}

function addPointerGlow() {
    const cards = document.querySelectorAll(".skill-card, .project-card");

    cards.forEach((card) => {
        card.addEventListener("pointermove", (event) => {
            const rect = card.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            card.style.background = `
                radial-gradient(circle at ${x}px ${y}px, rgba(140, 236, 255, 0.16), transparent 34%),
                linear-gradient(145deg, rgba(255, 255, 255, 0.115), rgba(255, 255, 255, 0.035)),
                rgba(255, 255, 255, 0.045)
            `;
        });

        card.addEventListener("pointerleave", () => {
            card.style.background = "";
        });
    });
}

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
revealOnScroll();
addPointerGlow();

if (!prefersReducedMotion) {
    renderStars();
    window.setTimeout(scheduleMeteor, 600);
} else {
    renderStars(0);
    cancelAnimationFrame(animationFrame);
}
