const checkTurnstile = async ({ page }) => {
    try {
        const elements = await page.locator('[name="cf-turnstile-response"]').all();
        if (elements.length <= 0) {
            const coordinates = await page.evaluate(() => {
                let coordinates = [];
                document.querySelectorAll('div').forEach(item => {
                    try {
                        let itemCoordinates = item.getBoundingClientRect();
                        let itemCss = window.getComputedStyle(item);
                        if (itemCss.margin == "0px" && itemCss.padding == "0px" && itemCoordinates.width > 290 && itemCoordinates.width <= 310 && !item.querySelector('*')) {
                            coordinates.push({ x: itemCoordinates.x, y: item.getBoundingClientRect().y, w: item.getBoundingClientRect().width, h: item.getBoundingClientRect().height });
                        }
                    } catch (err) { }
                });

                if (coordinates.length <= 0) {
                    document.querySelectorAll('div').forEach(item => {
                        try {
                            let itemCoordinates = item.getBoundingClientRect();
                            if (itemCoordinates.width > 290 && itemCoordinates.width <= 310 && !item.querySelector('*')) {
                                coordinates.push({ x: itemCoordinates.x, y: item.getBoundingClientRect().y, w: item.getBoundingClientRect().width, h: item.getBoundingClientRect().height });
                            }
                        } catch (err) { }
                    });
                }
                return coordinates;
            });

            for (const item of coordinates) {
                try {
                    let x = item.x + 30;
                    let y = item.y + item.h / 2;
                    await page.mouse.click(x, y);
                } catch (err) { }
            }
            return true;
        }

        for (const element of elements) {
            try {
                // Get the parent element bounding box
                const box = await element.evaluate(el => {
                    const parent = el.parentElement;
                    if (!parent) return null;
                    const rect = parent.getBoundingClientRect();
                    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                });
                if (box) {
                    let x = box.x + 30;
                    let y = box.y + box.height / 2;
                    await page.mouse.click(x, y);
                }
            } catch (err) { }
        }
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = { checkTurnstile };