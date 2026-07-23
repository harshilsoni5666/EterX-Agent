document.addEventListener('DOMContentLoaded', () => {
    // Mobile menu toggle
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    let navOpen = false;

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            navOpen = !navOpen;
            // Toggle logic if needed for mobile dropdown
        });
    }

    // Terminal simulation typing effect & interactivity
    const terminalOutput = document.getElementById('terminal-output');
    if (terminalOutput) {
        const sampleCommands = [
            { cmd: 'eterx benchmark --suite=agent-speed', output: '[Benchmark] Executing 50 concurrent tasks...\n[Success] Completed in 14.2s (0 failures, 100% verified).' },
            { cmd: 'eterx swarm status --all', output: '[Swarm] 5 active agents running.\n- Cartographer: Idle\n- Surgeon: Ready\n- QA Tester: Verifying build' },
            { cmd: 'eterx security audit --strict', output: '[Security] Scanning workspace for vulnerabilities...\n[Result] 0 secrets exposed. All permissions verified within sandbox bounds.' }
        ];

        let index = 0;
        setInterval(() => {
            const current = sampleCommands[index % sampleCommands.length];
            // Periodically append simulated live telemetry
            const line = document.createElement('div');
            line.className = 'text-slate-400 text-xs pl-4 border-l border-slate-800 animate-fadeIn';
            line.innerHTML = `<span class="text-cyan-400 font-bold">❯</span> <span class="text-white">${current.cmd}</span><br><span class="text-slate-500">${current.output.replace(/\n/g, '<br>')}</span>`;
            
            if (terminalOutput.children.length > 10) {
                terminalOutput.removeChild(terminalOutput.children[2]);
            }
            terminalOutput.appendChild(line);
            terminalOutput.scrollTop = terminalOutput.scrollHeight;
            index++;
        }, 8000);
    }

    // Intersection Observer for fade-in animations
    const observerOptions = {
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('opacity-100', 'translate-y-0');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    document.querySelectorAll('section > div').forEach(section => {
        section.classList.add('transition-all', 'duration-700', 'opacity-90', 'translate-y-2');
        observer.observe(section);
    });
});
