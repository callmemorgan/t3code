import type { ResponseAnnotation } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

export const ResponseAnnotationSummary = memo(function ResponseAnnotationSummary(props: {
  readonly annotations: ReadonlyArray<ResponseAnnotation>;
  readonly onSelect: (annotation: ResponseAnnotation, index: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (props.annotations.length === 0) {
    return null;
  }

  const label = `${props.annotations.length} ${
    props.annotations.length === 1 ? "annotation" : "annotations"
  }`;

  return (
    <View className="mt-1 items-end">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${expanded ? "Hide" : "Show"} annotation list`}
        accessibilityState={{ expanded }}
        className="flex-row items-center gap-1 rounded-full border border-border bg-subtle px-2.5 py-1.5"
        onPress={() => setExpanded((current) => !current)}
      >
        <SymbolView
          name="text.bubble"
          size={13}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <Text className="font-t3-medium text-xs text-foreground-secondary">{label}</Text>
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
      </Pressable>
      {expanded ? (
        <View className="mt-1 w-full rounded-xl border border-border p-1">
          <ScrollView nestedScrollEnabled className="max-h-72">
            <View className="gap-1">
              {props.annotations.map((annotation, index) => {
                const comment = annotation.comment.trim();
                return (
                  <Pressable
                    key={annotation.id}
                    accessibilityRole="button"
                    accessibilityLabel={`Go to Annotation ${index + 1}`}
                    className="rounded-lg px-2.5 py-2"
                    onPress={() => props.onSelect(annotation, index + 1)}
                  >
                    <Text className="font-t3-medium text-xs text-foreground">
                      Annotation {index + 1}
                    </Text>
                    <Text
                      numberOfLines={2}
                      className="mt-0.5 text-xs leading-4 text-foreground-secondary"
                    >
                      {annotation.selectedText}
                    </Text>
                    {comment.length > 0 ? (
                      <Text numberOfLines={2} className="mt-1 text-xs leading-4 text-foreground/80">
                        {comment}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
});
