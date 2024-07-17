    //  <script type="text/javascript">
    function googleTranslateElementInit() {
        new google.translate.TranslateElement({
                pageLanguage: "en",
                layout: google.translate.TranslateElement.InlineLayout.VERTICAL,
                includedLanguages: 'en,fr'
            },
            "google_translate_element"
        );
    }

    // Customizing drop down menu source: https://stackoverflow.com/questions/11881361/customizing-google-translator-drop-down
    $("document").ready(function() {
        $("#google_translate_element").on("click", function() {
            event.preventDefault();
            // Change font family and color
            $("iframe")
                .contents()
                .find(
                    ".goog-te-menu2-item div, .goog-te-menu2-item:link div, .goog-te-menu2-item:visited div, .goog-te-menu2-item:active div, .goog-te-menu2 *"
                )
                .css({
                    color: "red",
                    "font-family": "sans-serif",
                });

            // Change hover effects
            $("iframe")
                .contents()
                .find(".goog-te-menu2-item div")
                .hover(
                    function() {
                        $(this)
                            .css("background-color", "red")
                            .find("span.text")
                            .css("color", "red");
                    },
                    function() {
                        $(this)
                            .css("background-color", "red")
                            .find("span.text")
                            .css("color", "red");
                    }
                );

            // Change Google's default blue border
            $("iframe")
                .contents()
                .find(".goog-te-menu2")
                .css("border", "1px solid #F38256");
            // Change the iframe's box shadow
            $(".goog-te-menu-frame").css({
                "-moz-box-shadow": "0 3px 8px 2px #666666",
                "-webkit-box-shadow": "0 3px 8px 2px #666",
                "box-shadow": "0 3px 8px 2px #666",
            });
        });
    });
