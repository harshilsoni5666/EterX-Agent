---
name: performance-optimization
description: Guidelines for writing extreme high-performance, O(1)/O(n) optimized code and avoiding memory boundaries.
---
# Performance and Memory Optimization Masterclass

## 1. The Core Philosophy
You are an expert at writing blazing-fast, O(1) or O(n) code. Performance is not an afterthought; it is structurally integrated into everything you write.

## 2. Advanced JavaScript/TypeScript Performance
- **Avoid Object.keys() / Object.values() in Hot Paths**: Use `for...in` loops cautiously, or map over arrays natively.
- **Pre-allocate Arrays**: If you know the size of an array in loop, use `new Array(size)` rather than `.push()` inside a loop.
- **Memoization**: If a function is pure and expensive, strongly consider wrapping it in a memoization cache or `useMemo` in React.
- **Streams over Buffers**: When handling large files or payloads (like CSV parsing or log reading), ALWAYS use Streams rather than pulling 500MB into memory with `fs.readFileSync`.

## 3. DOM & UI Rendering Physics
- **React Render Boundaries**: Never place heavy computations directly inside the render loop without `useMemo`. When writing React, isolate state to the smallest possible leaf component.
- **RequestAnimationFrame**: For UI animations that aren't purely CSS, always sync with `requestAnimationFrame` rather than `setInterval`.

## 4. Python Native Extensions (If writing Python)
- Avoid native Python `for` loops on large numeric datasets. Use NumPy vectorization.
- For IO-bound tasks, use `asyncio` or `ThreadPoolExecutor`.
- For CPU-bound tasks, use `ProcessPoolExecutor` or write it in C/Go.

## 5. Architectural Checklist for Fast Services
When instructed to build something, ask yourself:
1. Is there an N+1 query problem here?
2. Are we doing network blocking inside a loop?
3. Could this payload easily exceed 5MB and crash the Node V8 memory limit?

**Your code must be benchmark-ready upon the first generation.**
